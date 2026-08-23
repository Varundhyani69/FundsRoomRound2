// frontend/src/screens/WorkOrdersScreen.test.jsx -- permanent component
// tests for WorkOrdersScreen.jsx (task 10.11), extended when the
// Location/Item/Assigned User text inputs became <select> dropdowns backed
// by GET /api/items, GET /api/locations, and GET /api/users
// (useReferenceData), since a bare 24-character hex text box was not
// something a person could fill in from memory.
//
// useAuth() is mocked per test to control the current role; permissions.js
// is left real so canWrite() is exercised the same way the screen uses it.
//
// WorkOrdersScreen now issues GET /api/items, GET /api/locations, and
// GET /api/users (via useReferenceData, fired in that order by
// Promise.all) before its own GET /api/work-orders list load, so every
// test queues get() resolutions in that four-call order: items, locations,
// users, work orders.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WorkOrdersScreen from './WorkOrdersScreen.jsx';
import { get, post, patch } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

vi.mock('../api/client.js', () => import('../test/mockApiClient.js'));
vi.mock('../auth/AuthContext.jsx', () => ({
    useAuth: vi.fn(),
}));

const SAMPLE_ORDER = {
    id: 'wo1',
    location: { code: 'LOC1', name: 'Warehouse' },
    item: { code: 'ITM1', name: 'Widget' },
    requiredQuantity: 50,
    assignedUser: { email: 'ops@example.com' },
    status: 'Assigned',
    shortageQuantity: 10,
};

const REFERENCE_ITEMS = [{ id: 'item-id', code: 'ITM1', name: 'Widget' }];
const REFERENCE_LOCATIONS = [{ id: 'loc-id', code: 'LOC1', name: 'Warehouse' }];
const REFERENCE_USERS = [{ id: 'user-id', email: 'ops@example.com', role: 'OperationsUser' }];

/**
 * Queues the three reference-data GETs (items, locations, users) ahead of
 * the initial list GET. useReferenceData's effect only runs on mount, so a
 * write handler's later refetch calls GET /api/work-orders alone.
 */
function queueInitialLoad(listResult) {
    get.mockResolvedValueOnce(REFERENCE_ITEMS);
    get.mockResolvedValueOnce(REFERENCE_LOCATIONS);
    get.mockResolvedValueOnce(REFERENCE_USERS);
    get.mockResolvedValueOnce(listResult);
}

describe('WorkOrdersScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('renders the documented columns', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        queueInitialLoad([SAMPLE_ORDER]);
        render(<WorkOrdersScreen />);

        await waitFor(() => expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument());

        ['ID', 'Location', 'Item', 'Required Quantity', 'Assigned User', 'Status', 'Shortage Quantity'].forEach(
            (label) => {
                expect(screen.getByText(label)).toBeInTheDocument();
            }
        );
        expect(screen.getByText('LOC1 - Warehouse')).toBeInTheDocument();
        expect(screen.getByText('50')).toBeInTheDocument();
        expect(screen.getByText('ops@example.com')).toBeInTheDocument();
        expect(screen.getByText('Assigned')).toBeInTheDocument();
        expect(screen.getByText('10')).toBeInTheDocument();
    });

    test('the New Work Order button is shown for Admin and opens the creation form in a dialog', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        queueInitialLoad([]);
        render(<WorkOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No work orders found')).toBeInTheDocument());
        // The form is a popup now, so the list is not pushed down by a form
        // that is always on screen.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '+ New Work Order' }));

        expect(screen.getByRole('dialog', { name: 'Create Work Order' })).toBeInTheDocument();
    });

    test('the New Work Order button is hidden for a non-Admin role', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([]);
        render(<WorkOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No work orders found')).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: '+ New Work Order' })).not.toBeInTheDocument();
    });

    test('status-change control triggers a refetch on success', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([SAMPLE_ORDER]);
        patch.mockResolvedValueOnce({});
        const refetchedOrder = { ...SAMPLE_ORDER, status: 'InProgress', shortageQuantity: 0 };
        get.mockResolvedValueOnce([refetchedOrder]); // the refetch: GET /api/work-orders only

        render(<WorkOrdersScreen />);

        await waitFor(() => expect(screen.getByText('Advance to InProgress')).toBeInTheDocument());
        fireEvent.click(screen.getByText('Advance to InProgress'));

        await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/work-orders/wo1/status', { status: 'InProgress' }));
        await waitFor(() => expect(screen.getByText('InProgress')).toBeInTheDocument());
    });

    test('submit and status controls disable while in flight', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        queueInitialLoad([SAMPLE_ORDER]);

        let resolvePatch;
        patch.mockReturnValue(
            new Promise((resolve) => {
                resolvePatch = resolve;
            })
        );

        render(<WorkOrdersScreen />);

        await waitFor(() => expect(screen.getByText('Advance to InProgress')).toBeInTheDocument());
        fireEvent.click(screen.getByText('Advance to InProgress'));

        expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();

        resolvePatch({});
        get.mockResolvedValueOnce([{ ...SAMPLE_ORDER, status: 'InProgress' }]); // the refetch: GET /api/work-orders only

        await waitFor(() => expect(screen.getByText('InProgress')).toBeInTheDocument());
    });

    test('the location, item, and assigned user fields are dropdowns populated from the reference lists', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        queueInitialLoad([]);
        render(<WorkOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No work orders found')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: '+ New Work Order' }));

        expect(screen.getByLabelText('Location')).toHaveDisplayValue('Select a location…');
        expect(screen.getByText('LOC1 - Warehouse')).toBeInTheDocument();
        expect(screen.getByLabelText('Item')).toHaveDisplayValue('Select an item…');
        expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument();
        expect(screen.getByLabelText('Assigned User')).toHaveDisplayValue('Select a user…');
        expect(screen.getByText('ops@example.com (OperationsUser)')).toBeInTheDocument();
    });
});
