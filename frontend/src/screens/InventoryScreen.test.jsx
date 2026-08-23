// frontend/src/screens/InventoryScreen.test.jsx -- permanent component
// tests for InventoryScreen.jsx (task 10.11), extended to cover the
// creation form and per-row adjust control added to close the gap where
// Admin/OperationsUser had no way to reach POST /api/inventory or
// POST /api/inventory/:id/adjust from the browser, and further extended
// when the Item/Location text inputs became <select> dropdowns backed by
// GET /api/items and GET /api/locations (useReferenceData), since a bare
// 24-character hex text box was not something a person could fill in from
// memory.
//
// api/client.js is replaced with the shared mock so `get()`/`post()` can be
// controlled per test without hitting a real API. useAuth() is mocked per
// test to control the current role, the same pattern
// WorkOrdersScreen.test.jsx/TransfersScreen.test.jsx already use; permissions.js
// is left real so canWrite() is exercised the same way the screen uses it.
//
// InventoryScreen issues GET /api/items and GET /api/locations (via
// useReferenceData, fired in that order by Promise.all) once on mount,
// before its own GET /api/inventory list load. useReferenceData's effect
// dependencies never change after mount, so a write handler's later
// refetch calls GET /api/inventory alone -- only the initial load needs
// the reference-data GETs queued ahead of it.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import InventoryScreen from './InventoryScreen.jsx';
import { get, post } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

vi.mock('../api/client.js', () => import('../test/mockApiClient.js'));
vi.mock('../auth/AuthContext.jsx', () => ({
    useAuth: vi.fn(),
}));

const SAMPLE_RECORD = {
    id: 'rec1',
    item: { code: 'ITM1', name: 'Widget', category: { name: 'Hardware' } },
    location: { code: 'LOC1', name: 'Warehouse' },
    batch: 'B1',
    physicalQuantity: 100,
    reservedQuantity: 30,
    availableQuantity: 70,
};

const REFERENCE_ITEMS = [{ id: 'item-id', code: 'ITM1', name: 'Widget' }];
const REFERENCE_LOCATIONS = [{ id: 'loc-id', code: 'LOC1', name: 'Warehouse' }];

/** Queues the two reference-data GETs (items, locations) ahead of the initial list GET. */
function queueInitialLoad(listResult) {
    get.mockResolvedValueOnce(REFERENCE_ITEMS);
    get.mockResolvedValueOnce(REFERENCE_LOCATIONS);
    get.mockResolvedValueOnce(listResult);
}

describe('InventoryScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('renders the documented columns from a mocked get() response', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        queueInitialLoad([SAMPLE_RECORD]);
        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument());

        ['Item', 'Category', 'Location', 'Batch', 'Physical Quantity', 'Reserved Quantity', 'Available Quantity'].forEach(
            (label) => {
                expect(screen.getByText(label)).toBeInTheDocument();
            }
        );
        expect(screen.getByText('Hardware')).toBeInTheDocument();
        expect(screen.getByText('B1')).toBeInTheDocument();
        expect(screen.getByText('100')).toBeInTheDocument();
        expect(screen.getByText('30')).toBeInTheDocument();
        expect(screen.getByText('70')).toBeInTheDocument();
    });

    test('shows EmptyState for zero rows', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        queueInitialLoad([]);
        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('No inventory records found')).toBeInTheDocument());
    });

    test('shows ErrorBanner on a rejected get() without crashing', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        get.mockResolvedValueOnce(REFERENCE_ITEMS);
        get.mockResolvedValueOnce(REFERENCE_LOCATIONS);
        get.mockRejectedValueOnce(new Error('Server error'));
        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Server error'));
    });

    test('the New Record button is shown for Admin and opens the creation form in a dialog', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        queueInitialLoad([]);
        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('No inventory records found')).toBeInTheDocument());
        // The form is a popup now, so nothing form-related is on screen until
        // the button is pressed -- the list is not pushed down by a form.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '+ New Record' }));

        expect(screen.getByRole('dialog', { name: 'Create Inventory Record' })).toBeInTheDocument();
    });

    test('the New Record button is shown for OperationsUser', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([]);
        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('No inventory records found')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: '+ New Record' })).toBeInTheDocument();
    });

    test('creation button and adjust control are hidden for SalesUser', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        queueInitialLoad([SAMPLE_RECORD]);
        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: '+ New Record' })).not.toBeInTheDocument();
        expect(screen.queryByText('Adjust')).not.toBeInTheDocument();
    });

    test('closing the dialog with Cancel hides the form again', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        queueInitialLoad([]);
        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('No inventory records found')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: '+ New Record' }));
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    test('the item and location fields are dropdowns populated from GET /api/items and GET /api/locations', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        queueInitialLoad([]);
        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('No inventory records found')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: '+ New Record' }));

        expect(screen.getByLabelText('Item')).toHaveDisplayValue('Select an item…');
        expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument();
        expect(screen.getByLabelText('Location')).toHaveDisplayValue('Select a location…');
        expect(screen.getByText('LOC1 - Warehouse')).toBeInTheDocument();
    });

    test('submitting the creation form calls post() and refetches the list', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        queueInitialLoad([]);
        post.mockResolvedValueOnce({});
        get.mockResolvedValueOnce([SAMPLE_RECORD]); // the refetch: GET /api/inventory only

        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('No inventory records found')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: '+ New Record' }));

        fireEvent.change(screen.getByLabelText('Item'), { target: { value: 'item-id' } });
        fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'loc-id' } });
        fireEvent.change(screen.getByLabelText('Batch'), { target: { value: 'B9' } });
        fireEvent.change(screen.getByLabelText('Physical Quantity'), { target: { value: '25' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Record' }));

        await waitFor(() => expect(post).toHaveBeenCalledWith('/api/inventory', expect.objectContaining({
            item: 'item-id',
            location: 'loc-id',
            batch: 'B9',
            physicalQuantity: 25,
        })));
        // "ITM1 - Widget" now appears twice: once in the (still-rendered)
        // dropdown option, once in the refetched table row -- so this
        // asserts the row specifically, via a cell unique to it.
        await waitFor(() => expect(screen.getByText('B1')).toBeInTheDocument());
    });

    test('opening the adjust control, submitting it, calls post() and refetches the list', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([SAMPLE_RECORD]);
        post.mockResolvedValueOnce({});
        const refetchedRecord = { ...SAMPLE_RECORD, physicalQuantity: 110, availableQuantity: 80 };
        get.mockResolvedValueOnce([refetchedRecord]); // the refetch: GET /api/inventory only

        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: 'Adjust' }));

        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10' } });
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

        await waitFor(() =>
            expect(post).toHaveBeenCalledWith(
                '/api/inventory/rec1/adjust',
                expect.objectContaining({ direction: 'IN', quantity: 10 })
            )
        );
        await waitFor(() => expect(screen.getByText('110')).toBeInTheDocument());
    });

    test('the adjust control disables its Apply button while the request is in flight', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        queueInitialLoad([SAMPLE_RECORD]);

        let resolvePost;
        post.mockReturnValue(
            new Promise((resolve) => {
                resolvePost = resolve;
            })
        );

        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: 'Adjust' }));
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

        expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled();

        resolvePost({});
        get.mockResolvedValueOnce([SAMPLE_RECORD]); // the refetch: GET /api/inventory only

        await waitFor(() => expect(post).toHaveBeenCalled());
    });
});
