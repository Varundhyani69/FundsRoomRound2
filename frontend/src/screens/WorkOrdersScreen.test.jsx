// frontend/src/screens/WorkOrdersScreen.test.jsx -- permanent component
// tests for WorkOrdersScreen.jsx (task 10.11), replacing the throwaway test
// written during task 10.7.
//
// useAuth() is mocked per test to control the current role; permissions.js
// is left real so canWrite() is exercised the same way the screen uses it.

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

describe('WorkOrdersScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('renders the documented columns', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        get.mockResolvedValueOnce([SAMPLE_ORDER]);
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

    test('creation form is visible for Admin', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        get.mockResolvedValueOnce([]);
        render(<WorkOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No work orders found')).toBeInTheDocument());
        expect(screen.getByRole('heading', { name: 'Create Work Order' })).toBeInTheDocument();
    });

    test('creation form is hidden for a non-Admin role', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        get.mockResolvedValueOnce([]);
        render(<WorkOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No work orders found')).toBeInTheDocument());
        expect(screen.queryByRole('heading', { name: 'Create Work Order' })).not.toBeInTheDocument();
    });

    test('status-change control triggers a refetch on success', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        get.mockResolvedValueOnce([SAMPLE_ORDER]);
        patch.mockResolvedValueOnce({});
        const refetchedOrder = { ...SAMPLE_ORDER, status: 'InProgress', shortageQuantity: 0 };
        get.mockResolvedValueOnce([refetchedOrder]);

        render(<WorkOrdersScreen />);

        await waitFor(() => expect(screen.getByText('Advance to InProgress')).toBeInTheDocument());
        fireEvent.click(screen.getByText('Advance to InProgress'));

        await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/work-orders/wo1/status', { status: 'InProgress' }));
        await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.getByText('InProgress')).toBeInTheDocument());
    });

    test('submit and status controls disable while in flight', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        get.mockResolvedValueOnce([SAMPLE_ORDER]);

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
        get.mockResolvedValueOnce([{ ...SAMPLE_ORDER, status: 'InProgress' }]);

        await waitFor(() => expect(screen.getByText('InProgress')).toBeInTheDocument());
    });
});
