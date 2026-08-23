// frontend/src/screens/WorkOrdersScreen.jsx -- follows InventoryScreen's
// shared screen pattern (design.md "Screen pattern") and extends it with a
// creation form and a per-row status-change control:
//   1. useEffect on mount -> request the list -> rows in local state.
//   2. Zero rows -> <EmptyState /> (Req 11.15).
//   3. Any non-401 error -> <ErrorBanner /> while leaving displayed values
//      untouched (Req 11.12). client.js already handles 401 globally, so
//      the only errors this screen ever sees are non-401.
//   4. The creation form and the status-change button each disable
//      themselves while their own request is in flight (Req 11.13).
//   5. On write success -> refetch the list and render the refetched
//      values (Req 11.14).
//
// Columns are exactly the Work_Order identifier, Location, Item,
// Required_Quantity, Assigned_User, Work_Order_Status, and Shortage_Quantity
// (Req 11.6), with location/item/assignedUser flattened out of the nested
// API response shape and shortageQuantity taken from the API response
// rather than recomputed in the browser.
//
// Role gating uses the mirrored permission map (auth/permissions.js) rather
// than an inline role check, so this screen and the backend stay driven by
// the same route-to-role table (design.md "Role gating"):
//   - the creation form only when canWrite('POST /api/work-orders', role)
//     is true, which today means Admin only (Req 11.7)
//   - the status-change control only when
//     canWrite('PATCH /api/work-orders/:id/status', role) is true, which
//     today means Admin or OperationsUser

import { useCallback, useEffect, useState } from 'react';
import { get, post, patch } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { canWrite } from '../auth/permissions.js';
import DataTable from '../components/DataTable.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import StatusBadge from '../components/StatusBadge.jsx';

const BASE_COLUMNS = [
    { key: 'id', label: 'ID' },
    { key: 'locationLabel', label: 'Location' },
    { key: 'itemLabel', label: 'Item' },
    { key: 'requiredQuantity', label: 'Required Quantity' },
    { key: 'assignedUserLabel', label: 'Assigned User' },
    { key: 'status', label: 'Status' },
    { key: 'shortageQuantity', label: 'Shortage Quantity' },
];

const ACTIONS_COLUMN = { key: 'actions', label: 'Status Change' };

// The same Assigned -> InProgress -> Completed rule the backend's
// nextWorkOrderStatus enforces (workOrder.service.js), duplicated here only
// to pick the button's label/target status. The backend remains the
// authoritative check; a rejected PATCH still surfaces via ErrorBanner.
const NEXT_STATUS = {
    Assigned: 'InProgress',
    InProgress: 'Completed',
};

// Flattens one populated WorkOrder response (nested location/item/
// assignedUser objects) into the flat keys DataTable renders (Req 11.6).
function toRow(order) {
    return {
        id: order.id,
        locationLabel: `${order.location.code} - ${order.location.name}`,
        itemLabel: `${order.item.code} - ${order.item.name}`,
        requiredQuantity: order.requiredQuantity,
        assignedUserLabel: order.assignedUser.email,
        status: <StatusBadge status={order.status} />,
        shortageQuantity: order.shortageQuantity,
    };
}

export default function WorkOrdersScreen() {
    const { role } = useAuth();

    const [workOrders, setWorkOrders] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    // Creation form state (Req 11.7). Plain text inputs for the ObjectId
    // fields since this screen has no dropdown-populating requirement.
    const [formLocation, setFormLocation] = useState('');
    const [formItem, setFormItem] = useState('');
    const [formRequiredQuantity, setFormRequiredQuantity] = useState('');
    const [formAssignedUser, setFormAssignedUser] = useState('');
    const [creating, setCreating] = useState(false);

    // Tracks which row's status-change button is mid-request, so only that
    // row's control disables itself (Req 11.13) rather than every row's.
    const [statusBusyId, setStatusBusyId] = useState(null);

    const canCreate = canWrite('POST /api/work-orders', role);
    const canChangeStatus = canWrite('PATCH /api/work-orders/:id/status', role);

    // Shared by the mount effect and every write handler's refetch
    // (Req 11.14), so there is one place that knows how to load this
    // screen's list.
    const loadWorkOrders = useCallback(async () => {
        try {
            const orders = await get('/api/work-orders');
            setWorkOrders(orders);
            setError(null);
        } catch (err) {
            // Leave any previously displayed rows untouched (Req 11.12).
            setError(err.message);
        }
    }, []);

    useEffect(() => {
        loadWorkOrders().finally(() => setLoading(false));
    }, [loadWorkOrders]);

    async function handleCreate(event) {
        event.preventDefault();
        setError(null);
        setCreating(true);
        try {
            await post('/api/work-orders', {
                location: formLocation,
                item: formItem,
                requiredQuantity: Number(formRequiredQuantity),
                assignedUser: formAssignedUser,
            });
            setFormLocation('');
            setFormItem('');
            setFormRequiredQuantity('');
            setFormAssignedUser('');
            await loadWorkOrders(); // Req 11.14
        } catch (err) {
            setError(err.message);
        } finally {
            setCreating(false);
        }
    }

    async function handleAdvanceStatus(id, nextStatus) {
        setError(null);
        setStatusBusyId(id);
        try {
            await patch(`/api/work-orders/${id}/status`, { status: nextStatus });
            await loadWorkOrders(); // Req 11.14
        } catch (err) {
            setError(err.message);
        } finally {
            setStatusBusyId(null);
        }
    }

    // Builds the actions cell for one order: the next legal status becomes
    // the button's label/target, and there is no successor of `Completed`
    // so the control is omitted entirely on those rows.
    function renderStatusControl(order) {
        const nextStatus = NEXT_STATUS[order.status];
        if (!nextStatus) {
            return null;
        }
        const busy = statusBusyId === order.id;
        return (
            <button
                type="button"
                disabled={busy}
                onClick={() => handleAdvanceStatus(order.id, nextStatus)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
                {busy ? 'Updating…' : `Advance to ${nextStatus}`}
            </button>
        );
    }

    const columns = canChangeStatus ? [...BASE_COLUMNS, ACTIONS_COLUMN] : BASE_COLUMNS;
    const rows = workOrders.map((order) => {
        const row = toRow(order);
        if (canChangeStatus) {
            row.actions = renderStatusControl(order);
        }
        return row;
    });

    return (
        <main>
            <h1 className="mb-4 text-2xl font-semibold text-slate-900">Work Orders</h1>
            <ErrorBanner message={error} />

            {canCreate && (
                <form onSubmit={handleCreate} className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                    <h2 className="mb-4 text-base font-semibold text-slate-900">Create Work Order</h2>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                            <label htmlFor="work-order-location" className="mb-1 block text-sm font-medium text-slate-700">
                                Location ID
                            </label>
                            <input
                                id="work-order-location"
                                type="text"
                                value={formLocation}
                                onChange={(event) => setFormLocation(event.target.value)}
                                required
                                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                        </div>
                        <div>
                            <label htmlFor="work-order-item" className="mb-1 block text-sm font-medium text-slate-700">
                                Item ID
                            </label>
                            <input
                                id="work-order-item"
                                type="text"
                                value={formItem}
                                onChange={(event) => setFormItem(event.target.value)}
                                required
                                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                        </div>
                        <div>
                            <label
                                htmlFor="work-order-required-quantity"
                                className="mb-1 block text-sm font-medium text-slate-700"
                            >
                                Required Quantity
                            </label>
                            <input
                                id="work-order-required-quantity"
                                type="number"
                                min="1"
                                value={formRequiredQuantity}
                                onChange={(event) => setFormRequiredQuantity(event.target.value)}
                                required
                                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                        </div>
                        <div>
                            <label
                                htmlFor="work-order-assigned-user"
                                className="mb-1 block text-sm font-medium text-slate-700"
                            >
                                Assigned User ID
                            </label>
                            <input
                                id="work-order-assigned-user"
                                type="text"
                                value={formAssignedUser}
                                onChange={(event) => setFormAssignedUser(event.target.value)}
                                required
                                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                        </div>
                    </div>
                    <button
                        type="submit"
                        disabled={creating}
                        className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {creating ? 'Creating…' : 'Create Work Order'}
                    </button>
                </form>
            )}

            {loading ? (
                <p className="text-sm text-slate-500">Loading…</p>
            ) : rows.length === 0 ? (
                <EmptyState message="No work orders found" />
            ) : (
                <DataTable columns={columns} rows={rows} />
            )}
        </main>
    );
}
