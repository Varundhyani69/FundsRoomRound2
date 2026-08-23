// frontend/src/screens/CustomerOrdersScreen.jsx -- the Customer Orders
// screen, following InventoryScreen's shared screen pattern (design.md
// "Screen pattern") extended with the one write control this screen owns:
//   1. useEffect on mount -> GET /api/orders -> rows in local state.
//   2. Zero rows -> <EmptyState /> (Req 11.15).
//   3. Any non-401 error -> <ErrorBanner /> while leaving displayed values
//      untouched (Req 11.12). client.js already handles 401 globally, so
//      the only errors this screen ever sees are non-401 -- including
//      INSUFFICIENT_AVAILABLE_QUANTITY when a reservation is rejected for
//      exceeding availability, which lands in the same banner.
//   4. The creation form disables its submit control while the request is
//      in flight (Req 11.13).
//   5. On write success -> refetch the list and render the refetched
//      values (Req 11.14).
//
// Columns are exactly Customer Name, Item, Location, Quantity, Status
// (Req 11.10). The creation form renders only on this screen, and only for
// roles the backend permits on POST /api/orders (Req 11.11), decided by
// `canWrite('POST /api/orders', role)` against the mirrored permission
// constant (Req 2.9) -- Admin and SalesUser today.

import { useEffect, useState } from 'react';
import { get, post } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { canWrite } from '../auth/permissions.js';
import DataTable from '../components/DataTable.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import StatusBadge from '../components/StatusBadge.jsx';

const COLUMNS = [
    { key: 'customerName', label: 'Customer Name' },
    { key: 'itemLabel', label: 'Item' },
    { key: 'locationLabel', label: 'Location' },
    { key: 'quantity', label: 'Quantity' },
    { key: 'status', label: 'Status' },
];

// Flattens one populated CustomerOrder response (nested item/location
// objects) into the flat keys DataTable renders (Req 11.10).
function toRow(order) {
    return {
        id: order.id,
        customerName: order.customerName,
        itemLabel: `${order.item.code} - ${order.item.name}`,
        locationLabel: `${order.location.code} - ${order.location.name}`,
        quantity: order.quantity,
        status: <StatusBadge status={order.status} />,
    };
}

export default function CustomerOrdersScreen() {
    const { role } = useAuth();
    const canCreate = canWrite('POST /api/orders', role);

    const [rows, setRows] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    const [customerName, setCustomerName] = useState('');
    const [item, setItem] = useState('');
    const [location, setLocation] = useState('');
    const [quantity, setQuantity] = useState('');
    const [submitting, setSubmitting] = useState(false);

    async function load() {
        try {
            const orders = await get('/api/orders');
            setRows(orders.map(toRow));
            setError(null);
        } catch (err) {
            // Leave any previously displayed rows untouched (Req 11.12).
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        load();
    }, []);

    async function handleSubmit(event) {
        event.preventDefault();
        setError(null);
        setSubmitting(true);
        try {
            await post('/api/orders', {
                customerName,
                item,
                location,
                quantity: Number(quantity),
            });
            setCustomerName('');
            setItem('');
            setLocation('');
            setQuantity('');
            await load(); // refetch the list on success (Req 11.14)
        } catch (err) {
            // Covers rejections such as INSUFFICIENT_AVAILABLE_QUANTITY when
            // a reservation is rejected for exceeding availability -- shown
            // in the same banner as any other non-401 error (Req 11.12).
            setError(err.message);
        } finally {
            setSubmitting(false);
        }
    }

    const inputClass =
        'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

    return (
        <main>
            <h1 className="mb-4 text-2xl font-semibold text-slate-900">Customer Orders</h1>
            <ErrorBanner message={error} />
            {canCreate && (
                <form onSubmit={handleSubmit} className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <div>
                            <label htmlFor="order-customer-name" className="mb-1 block text-sm font-medium text-slate-700">
                                Customer Name
                            </label>
                            <input
                                id="order-customer-name"
                                type="text"
                                value={customerName}
                                onChange={(event) => setCustomerName(event.target.value)}
                                required
                                className={inputClass}
                            />
                        </div>
                        <div>
                            <label htmlFor="order-item" className="mb-1 block text-sm font-medium text-slate-700">
                                Item
                            </label>
                            <input
                                id="order-item"
                                type="text"
                                value={item}
                                onChange={(event) => setItem(event.target.value)}
                                required
                                className={inputClass}
                            />
                        </div>
                        <div>
                            <label htmlFor="order-location" className="mb-1 block text-sm font-medium text-slate-700">
                                Location
                            </label>
                            <input
                                id="order-location"
                                type="text"
                                value={location}
                                onChange={(event) => setLocation(event.target.value)}
                                required
                                className={inputClass}
                            />
                        </div>
                        <div>
                            <label htmlFor="order-quantity" className="mb-1 block text-sm font-medium text-slate-700">
                                Quantity
                            </label>
                            <input
                                id="order-quantity"
                                type="number"
                                value={quantity}
                                onChange={(event) => setQuantity(event.target.value)}
                                required
                                className={inputClass}
                            />
                        </div>
                    </div>
                    <button
                        type="submit"
                        disabled={submitting}
                        className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {submitting ? 'Creating…' : 'Create Order'}
                    </button>
                </form>
            )}
            {loading ? (
                <p className="text-sm text-slate-500">Loading…</p>
            ) : rows.length === 0 ? (
                <EmptyState message="No customer orders found" />
            ) : (
                <DataTable columns={COLUMNS} rows={rows} />
            )}
        </main>
    );
}
