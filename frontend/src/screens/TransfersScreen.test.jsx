// frontend/src/screens/TransfersScreen.test.jsx -- permanent component
// tests for TransfersScreen.jsx (task 10.11), replacing the throwaway test
// written during task 10.8.

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

describe('TransfersScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('renders the documented columns', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        get.mockResolvedValueOnce([makeTransfer()]);
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
        get.mockResolvedValueOnce([makeTransfer({ status: 'Requested' })]);
        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('Dispatch')).toBeInTheDocument());
        expect(screen.queryByText('Receive')).not.toBeInTheDocument();
    });

    test('receive control appears only on Dispatched rows for a permitted role', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        get.mockResolvedValueOnce([makeTransfer({ status: 'Dispatched' })]);
        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('Receive')).toBeInTheDocument());
        expect(screen.queryByText('Dispatch')).not.toBeInTheDocument();
    });

    test('neither control appears on a Received row', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        get.mockResolvedValueOnce([makeTransfer({ status: 'Received' })]);
        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('Received')).toBeInTheDocument());
        expect(screen.queryByText('Dispatch')).not.toBeInTheDocument();
        expect(screen.queryByText('Receive')).not.toBeInTheDocument();
    });

    test('controls are gated by role: no dispatch/receive for SalesUser', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        get.mockResolvedValueOnce([makeTransfer({ status: 'Requested' })]);
        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument());
        expect(screen.queryByText('Dispatch')).not.toBeInTheDocument();
        expect(screen.queryByText('Receive')).not.toBeInTheDocument();
    });

    test('refetches the list after a successful dispatch', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        get.mockResolvedValueOnce([makeTransfer({ status: 'Requested' })]);
        post.mockResolvedValueOnce({});
        get.mockResolvedValueOnce([makeTransfer({ status: 'Dispatched' })]);

        render(<TransfersScreen />);

        await waitFor(() => expect(screen.getByText('Dispatch')).toBeInTheDocument());
        fireEvent.click(screen.getByText('Dispatch'));

        await waitFor(() => expect(post).toHaveBeenCalledWith('/api/transfers/t1/dispatch', {}));
        await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.getByText('Dispatched')).toBeInTheDocument());
    });
});
