// frontend/src/screens/CustomerOrdersScreen.test.jsx -- permanent component
// tests for CustomerOrdersScreen.jsx (task 10.11), extended when the Item/
// Location text inputs became <select> dropdowns backed by GET /api/items
// and GET /api/locations (useReferenceData), since a bare 24-character hex
// text box was not something a person could fill in from memory.
//
// CustomerOrdersScreen now issues GET /api/items and GET /api/locations
// (via useReferenceData, fired in that order by Promise.all) before its
// own GET /api/orders list load, so every test queues get() resolutions in
// that three-call order: items, locations, orders.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CustomerOrdersScreen from './CustomerOrdersScreen.jsx';
import { get, post } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

vi.mock('../api/client.js', () => import('../test/mockApiClient.js'));
vi.mock('../auth/AuthContext.jsx', () => ({
    useAuth: vi.fn(),
}));

const SAMPLE_ORDER = {
    id: 'o1',
    customerName: 'Acme Corp',
    item: { code: 'ITM1', name: 'Widget' },
    location: { code: 'LOC1', name: 'Warehouse' },
    quantity: 15,
    status: 'Reserved',
};

const REFERENCE_ITEMS = [{ id: 'item-id', code: 'ITM1', name: 'Widget' }];
const REFERENCE_LOCATIONS = [{ id: 'loc-id', code: 'LOC1', name: 'Warehouse' }];

/**
 * Queues the two reference-data GETs (items, locations) ahead of the
 * initial list GET. useReferenceData's effect only runs on mount, so a
 * write handler's later refetch calls GET /api/orders alone.
 */
function queueInitialLoad(listResult) {
    get.mockResolvedValueOnce(REFERENCE_ITEMS);
    get.mockResolvedValueOnce(REFERENCE_LOCATIONS);
    get.mockResolvedValueOnce(listResult);
}

describe('CustomerOrdersScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('renders the documented columns', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([SAMPLE_ORDER]);
        render(<CustomerOrdersScreen />);

        await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());

        ['Customer Name', 'Item', 'Location', 'Quantity', 'Status'].forEach((label) => {
            expect(screen.getByText(label)).toBeInTheDocument();
        });
        expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument();
        expect(screen.getByText('LOC1 - Warehouse')).toBeInTheDocument();
        expect(screen.getByText('15')).toBeInTheDocument();
        expect(screen.getByText('Reserved')).toBeInTheDocument();
    });

    test('the New Order button is shown for SalesUser and opens the creation form in a dialog', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        queueInitialLoad([]);
        render(<CustomerOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No customer orders found')).toBeInTheDocument());
        // The form is a popup now, so the list is not pushed down by a form
        // that is always on screen.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '+ New Order' }));

        expect(screen.getByRole('dialog', { name: 'Create Order' })).toBeInTheDocument();
    });

    test('the New Order button is shown for Admin', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        queueInitialLoad([]);
        render(<CustomerOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No customer orders found')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: '+ New Order' })).toBeInTheDocument();
    });

    test('the New Order button is hidden for a role without order-write permission', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([]);
        render(<CustomerOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No customer orders found')).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: '+ New Order' })).not.toBeInTheDocument();
    });

    test('the item and location fields are dropdowns populated from GET /api/items and GET /api/locations', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        queueInitialLoad([]);
        render(<CustomerOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No customer orders found')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: '+ New Order' }));

        expect(screen.getByLabelText('Item')).toHaveDisplayValue('Select an item…');
        expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument();
        expect(screen.getByLabelText('Location')).toHaveDisplayValue('Select a location…');
        expect(screen.getByText('LOC1 - Warehouse')).toBeInTheDocument();
    });

    test('refetches the list after a successful order creation', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        queueInitialLoad([]);
        post.mockResolvedValueOnce({});
        get.mockResolvedValueOnce([SAMPLE_ORDER]); // the refetch: GET /api/orders only

        render(<CustomerOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No customer orders found')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: '+ New Order' }));

        fireEvent.change(screen.getByLabelText('Customer Name'), { target: { value: 'Acme Corp' } });
        fireEvent.change(screen.getByLabelText('Item'), { target: { value: 'item-id' } });
        fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'loc-id' } });
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '15' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Order' }));

        await waitFor(() =>
            expect(post).toHaveBeenCalledWith('/api/orders', {
                customerName: 'Acme Corp',
                item: 'item-id',
                location: 'loc-id',
                quantity: 15,
            })
        );
        await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    });
});
