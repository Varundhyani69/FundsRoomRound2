// frontend/src/screens/CustomerOrdersScreen.test.jsx -- permanent component
// tests for CustomerOrdersScreen.jsx (task 10.11), replacing the throwaway
// test written during task 10.9.

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

describe('CustomerOrdersScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('renders the documented columns', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        get.mockResolvedValueOnce([SAMPLE_ORDER]);
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

    test('creation form is visible for SalesUser', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        get.mockResolvedValueOnce([]);
        render(<CustomerOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No customer orders found')).toBeInTheDocument());
        expect(screen.getByText('Create Order')).toBeInTheDocument();
    });

    test('creation form is visible for Admin', async () => {
        useAuth.mockReturnValue({ role: 'Admin' });
        get.mockResolvedValueOnce([]);
        render(<CustomerOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No customer orders found')).toBeInTheDocument());
        expect(screen.getByText('Create Order')).toBeInTheDocument();
    });

    test('creation form is hidden for a role without order-write permission', async () => {
        useAuth.mockReturnValue({ role: 'OperationsUser' });
        get.mockResolvedValueOnce([]);
        render(<CustomerOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No customer orders found')).toBeInTheDocument());
        expect(screen.queryByText('Create Order')).not.toBeInTheDocument();
    });

    test('refetches the list after a successful order creation', async () => {
        useAuth.mockReturnValue({ role: 'SalesUser' });
        get.mockResolvedValueOnce([]);
        post.mockResolvedValueOnce({});
        get.mockResolvedValueOnce([SAMPLE_ORDER]);

        render(<CustomerOrdersScreen />);

        await waitFor(() => expect(screen.getByText('No customer orders found')).toBeInTheDocument());

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
        await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    });
});
