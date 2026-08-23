// frontend/src/screens/InventoryScreen.test.jsx -- permanent component
// tests for InventoryScreen.jsx (task 10.11), replacing the throwaway test
// written during task 10.6.
//
// api/client.js is replaced with the shared mock so `get()` can be
// controlled per test without hitting a real API.

import { render, screen, waitFor } from '@testing-library/react';
import InventoryScreen from './InventoryScreen.jsx';
import { get } from '../api/client.js';

vi.mock('../api/client.js', () => import('../test/mockApiClient.js'));

const SAMPLE_RECORD = {
    id: 'rec1',
    item: { code: 'ITM1', name: 'Widget', category: { name: 'Hardware' } },
    location: { code: 'LOC1', name: 'Warehouse' },
    batch: 'B1',
    physicalQuantity: 100,
    reservedQuantity: 30,
    availableQuantity: 70,
};

describe('InventoryScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('renders the documented columns from a mocked get() response', async () => {
        get.mockResolvedValueOnce([SAMPLE_RECORD]);
        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('ITM1 - Widget')).toBeInTheDocument());

        ['Item', 'Category', 'Location', 'Batch', 'Physical Quantity', 'Reserved Quantity', 'Available Quantity'].forEach(
            (label) => {
                expect(screen.getByText(label)).toBeInTheDocument();
            }
        );
        expect(screen.getByText('Hardware')).toBeInTheDocument();
        expect(screen.getByText('LOC1 - Warehouse')).toBeInTheDocument();
        expect(screen.getByText('B1')).toBeInTheDocument();
        expect(screen.getByText('100')).toBeInTheDocument();
        expect(screen.getByText('30')).toBeInTheDocument();
        expect(screen.getByText('70')).toBeInTheDocument();
    });

    test('shows EmptyState for zero rows', async () => {
        get.mockResolvedValueOnce([]);
        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByText('No inventory records found')).toBeInTheDocument());
    });

    test('shows ErrorBanner on a rejected get() without crashing', async () => {
        get.mockRejectedValueOnce(new Error('Server error'));
        render(<InventoryScreen />);

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Server error'));
    });
});
