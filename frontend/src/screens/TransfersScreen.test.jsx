// frontend/src/screens/TransfersScreen.test.jsx -- permanent component
// tests for TransfersScreen.jsx (task 10.11), extended when the Item/
// Source Location/Destination Location text inputs became <select>
// dropdowns backed by GET /api/items and GET /api/locations
// (useReferenceData), since a bare 24-character hex text box was not
// something a person could fill in from memory.
//
// TransfersScreen now issues GET /api/items and GET /api/locations (via
// useReferenceData, fired in that order by Promise.all) before its own
// GET /api/transfers list load, so every test queues get() resolutions in
// that three-call order: items, locations, transfers.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TransfersScreen from './TransfersScreen.jsx';
import { get, post } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

vi.mock('../api/client.js', () => import('../test/mockApiClient.js'));
vi.mock('../auth/AuthContext.jsx', () => ({
    useAuth: vi.fn(),
}));

function makeTransfer(overrides) {
    return {
        id: 't1',
        sourceLocation: { code: 'LOC1', name: 'Warehouse' },
        destinationLocation: { code: 'LOC2', name: 'Store' },
        item: { code: 'ITM1', name: 'Widget' },
        batch: 'B1',
        quantity: 20,
        status: 'Requested',
        ...overrides,
    };
}

const REFERENCE_ITEMS = [{ id: 'item-id', code: 'ITM1', name: 'Widget' }];
const REFERENCE_LOCATIONS = [
    { id: 'loc1-id', code: 'LOC1', name: 'Warehouse' },
    { id: 'loc2-id', code: 'LOC2', name: 'Store' },
];

/**
 * Queues the two reference-data GETs (items, locations) ahead of the
 * initial list GET. useReferenceData's effect only runs on mount, so a
 * write handler's later refetch calls GET /api/transfers alone.
 */
function queueInitialLoad(listResult) {
    get.mockResolvedValueOnce(REFERENCE_ITEMS);
    get.mockResolvedValueOnce(REFERENCE_LOCATIONS);
    get.mockResolvedValueOnce(listResult);
}

describe('TransfersScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('renders the documented columns', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        queueInitialLoad([makeTransfer()]);
        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument());

        ['ID', 'Source Location', 'Destination Location', 'Item', 'Batch', 'Quantity', 'Status'].forEach((label) => {
            expect(screen.getByText(label)).toBeInTheDocument();
        });
        expect(screen.getByText('LOC1 - Warehouse')).toBeInTheDocument();
        expect(screen.getByText('LOC2 - Store')).toBeInTheDocument();
        expect(screen.getByText('B1')).toBeInTheDocument();
        expect(screen.getByText('20')).toBeInTheDocument();
        expect(screen.getByText('Requested')).toBeInTheDocument();
    });

    test('dispatch control appears only on Requested rows for a permitted role', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([makeTransfer({ status: 'Requested' })]);
        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('Dispatch')).toBeInTheDocument());
        expect(screen.queryByText('Receive')).not.toBeInTheDocument();
    });

    test('receive control appears only on Dispatched rows for a permitted role', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([makeTransfer({ status: 'Dispatched' })]);
        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('Receive')).toBeInTheDocument());
        expect(screen.queryByText('Dispatch')).not.toBeInTheDocument();
    });

    test('neither control appears on a Received row', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([makeTransfer({ status: 'Received' })]);
        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('Received')).toBeInTheDocument());
        expect(screen.queryByText('Dispatch')).not.toBeInTheDocument();
        expect(screen.queryByText('Receive')).not.toBeInTheDocument();
    });

    test('controls are gated by role: no dispatch/receive for SalesUser', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        queueInitialLoad([makeTransfer({ status: 'Requested' })]);
        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument());
        expect(screen.queryByText('Dispatch')).not.toBeInTheDocument();
        expect(screen.queryByText('Receive')).not.toBeInTheDocument();
    });

    test('refetches the list after a successful dispatch', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([makeTransfer({ status: 'Requested' })]);
        post.mockResolvedValueOnce({});
        get.mockResolvedValueOnce([makeTransfer({ status: 'Dispatched' })]); // the refetch: GET /api/transfers only

        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('Dispatch')).toBeInTheDocument());
        fireEvent.click(screen.getByText('Dispatch'));

        await waitFor(() => expect(post).toHaveBeenCalledWith('/api/transfers/t1/dispatch', {}));
        await waitFor(() => expect(screen.getByText('Dispatched')).toBeInTheDocument());
    });

    test('the New Transfer button opens the creation form in a dialog', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([]);
        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('No internal transfers found')).toBeInTheDocument());
        // The form is a popup now, so the list is not pushed down by a form
        // that is always on screen.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '+ New Transfer' }));

        expect(screen.getByRole('dialog', { name: 'Create Transfer' })).toBeInTheDocument();
    });

    test('the item, source location, and destination location fields are dropdowns populated from the reference lists', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        queueInitialLoad([]);
        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('No internal transfers found')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: '+ New Transfer' }));

        expect(screen.getByLabelText('Item')).toHaveDisplayValue('Select an item…');
        expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument();
        expect(screen.getByLabelText('Source Location')).toHaveDisplayValue('Select a location…');
        expect(screen.getByLabelText('Destination Location')).toHaveDisplayValue('Select a location…');
        expect(screen.getAllByText('LOC1 - Warehouse').length).toBeGreaterThan(0);
        expect(screen.getAllByText('LOC2 - Store').length).toBeGreaterThan(0);
    });
});
