// frontend/src/screens/InventoryScreen.jsx -- follows the shared screen
// pattern every data screen uses (design.md "Screen pattern"), extended
// with a creation form and a per-row adjust (IN/OUT) control so Admin and
// OperationsUser can actually reach POST /api/inventory and
// POST /api/inventory/:id/adjust from the browser, not only over HTTP
// directly:
//   1. useEffect on mount -> request the list -> rows in local state.
//   2. Zero rows -> <EmptyState /> (Req 11.15).
//   3. Any non-401 error -> <ErrorBanner /> while leaving displayed values
//      untouched (Req 11.12). client.js already handles 401 globally, so
//      the only errors this screen ever sees are non-401.
//   4. The creation form and each row's adjust control disable themselves
//      while their own request is in flight (Req 11.13).
//   5. On write success -> refetch the list and render the refetched
//      values (Req 11.14).
//
// Columns are exactly Item, Category, Location, Batch, Physical Quantity,
// Reserved Quantity, Available Quantity (Req 11.5), with availableQuantity
// taken from the API response rather than recomputed in the browser.
//
// Role gating uses the mirrored permission map (auth/permissions.js), the
// same pattern the Work Orders / Transfers / Orders screens already use, so
// this screen stays driven by the same route-to-role table the backend
// enforces (design.md "Role gating"):
//   - the creation form only when canWrite('POST /api/inventory', role)
//   - the per-row adjust control only when
//     canWrite('POST /api/inventory/:id/adjust', role)
// Both are Admin/OperationsUser today; a SalesUser sees neither, matching
// backend/src/permissions.js exactly.

import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { canWrite } from '../auth/permissions.js';
import { useReferenceData } from '../hooks/useReferenceData.js';
import DataTable from '../components/DataTable.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';

const BASE_COLUMNS = [
    { key: 'itemLabel', label: 'Item' },
    { key: 'categoryLabel', label: 'Category' },
    { key: 'locationLabel', label: 'Location' },
    { key: 'batch', label: 'Batch' },
    { key: 'physicalQuantity', label: 'Physical Quantity' },
    { key: 'reservedQuantity', label: 'Reserved Quantity' },
    { key: 'availableQuantity', label: 'Available Quantity' },
];

const ACTIONS_COLUMN = { key: 'actions', label: 'Adjust' };

const EMPTY_ADJUST_FORM = { direction: 'IN', quantity: '' };

// Flattens one populated InventoryRecord response (nested item/category/
// location objects) into the flat keys DataTable renders (Req 11.5).
function toRow(record) {
    return {
        id: record.id,
        itemLabel: `${record.item.code} - ${record.item.name}`,
        categoryLabel: record.item.category.name,
        locationLabel: `${record.location.code} - ${record.location.name}`,
        batch: record.batch,
        physicalQuantity: record.physicalQuantity,
        reservedQuantity: record.reservedQuantity,
        availableQuantity: record.availableQuantity,
    };
}

export default function InventoryScreen() {
    const { role } = useAuth();

    const [rows, setRows] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    // Item/Location dropdown options for the creation form (Items and
    // Locations already exist as reference lists; a bare 24-character hex
    // text box is not something a person can fill in from memory).
    const { items, locations } = useReferenceData({ items: true, locations: true });

    // Creation form state. Plain text inputs for the ObjectId fields, the
    // same choice WorkOrdersScreen/TransfersScreen already make, since this
    // screen has no dropdown-populating requirement.
    const [formItem, setFormItem] = useState('');
    const [formLocation, setFormLocation] = useState('');
    const [formBatch, setFormBatch] = useState('');
    const [formPhysicalQuantity, setFormPhysicalQuantity] = useState('');
    const [creating, setCreating] = useState(false);
    // Whether the "Create Inventory Record" popup is open. The form itself
    // renders only inside <Modal>, so it is not permanently on screen above
    // the table (design decision: forms belong in a popup a person opens on
    // demand, not pinned above the list they came to see).
    const [createOpen, setCreateOpen] = useState(false);

    // Which row's adjust form is open, and that row's own direction/quantity
    // fields -- one row at a time, so opening a second row's form closes
    // whichever was open before it.
    const [openAdjustId, setOpenAdjustId] = useState(null);
    const [adjustForm, setAdjustForm] = useState(EMPTY_ADJUST_FORM);
    const [adjustingId, setAdjustingId] = useState(null);

    const canCreate = canWrite('POST /api/inventory', role);
    const canAdjust = canWrite('POST /api/inventory/:id/adjust', role);

    // Shared by the mount effect and every write handler's refetch
    // (Req 11.14), so there is one place that knows how to load this
    // screen's list.
    const loadRecords = useCallback(async () => {
        try {
            const records = await get('/api/inventory');
            setRows(records.map(toRow));
            setError(null);
        } catch (err) {
            // Leave any previously displayed rows untouched (Req 11.12).
            setError(err.message);
        }
    }, []);

    useEffect(() => {
        loadRecords().finally(() => setLoading(false));
    }, [loadRecords]);

    async function handleCreate(event) {
        event.preventDefault();
        setError(null);
        setCreating(true);
        try {
            await post('/api/inventory', {
                item: formItem,
                location: formLocation,
                batch: formBatch,
                physicalQuantity: Number(formPhysicalQuantity),
                movementReference: `web-create-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            });
            setFormItem('');
            setFormLocation('');
            setFormBatch('');
            setFormPhysicalQuantity('');
            setCreateOpen(false);
            await loadRecords(); // Req 11.14
        } catch (err) {
            setError(err.message);
        } finally {
            setCreating(false);
        }
    }

    function closeCreateModal() {
        // Only reachable while no submit is in flight (the Cancel/close
        // controls are inside the form and disable with the rest of it), so
        // this never abandons a request that is still pending.
        setCreateOpen(false);
    }

    function toggleAdjustForm(id) {
        setOpenAdjustId((current) => (current === id ? null : id));
        setAdjustForm(EMPTY_ADJUST_FORM);
    }

    async function handleAdjustSubmit(event, id) {
        event.preventDefault();
        setError(null);
        setAdjustingId(id);
        try {
            await post(`/api/inventory/${id}/adjust`, {
                direction: adjustForm.direction,
                quantity: Number(adjustForm.quantity),
                movementReference: `web-adjust-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            });
            setOpenAdjustId(null);
            setAdjustForm(EMPTY_ADJUST_FORM);
            await loadRecords(); // Req 11.14
        } catch (err) {
            setError(err.message);
        } finally {
            setAdjustingId(null);
        }
    }

    // Builds the actions cell for one record: a toggle button, and -- only
    // while open -- a small inline direction/quantity form for that row.
    function renderAdjustControl(id) {
        const isOpen = openAdjustId === id;
        const busy = adjustingId === id;

        return (
            <div>
                <button
                    type="button"
                    onClick={() => toggleAdjustForm(id)}
                    disabled={busy}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {isOpen ? 'Cancel' : 'Adjust'}
                </button>
                {isOpen && (
                    <form
                        onSubmit={(event) => handleAdjustSubmit(event, id)}
                        className="mt-2 flex flex-wrap items-end gap-2"
                    >
                        <label className="text-xs font-medium text-slate-600">
                            Direction
                            <select
                                value={adjustForm.direction}
                                onChange={(event) =>
                                    setAdjustForm((current) => ({ ...current, direction: event.target.value }))
                                }
                                className="mt-1 block rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                            >
                                <option value="IN">IN</option>
                                <option value="OUT">OUT</option>
                            </select>
                        </label>
                        <label className="text-xs font-medium text-slate-600">
                            Quantity
                            <input
                                type="number"
                                min="1"
                                required
                                value={adjustForm.quantity}
                                onChange={(event) =>
                                    setAdjustForm((current) => ({ ...current, quantity: event.target.value }))
                                }
                                className="mt-1 block w-24 rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                        </label>
                        <button
                            type="submit"
                            disabled={busy}
                            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {busy ? 'Applying…' : 'Apply'}
                        </button>
                    </form>
                )}
            </div>
        );
    }

    const columns = canAdjust ? [...BASE_COLUMNS, ACTIONS_COLUMN] : BASE_COLUMNS;
    const displayRows = rows.map((row) => {
        if (!canAdjust) {
            return row;
        }
        return { ...row, actions: renderAdjustControl(row.id) };
    });

    const inputClass =
        'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

    return (
        <main>
            <div className="mb-4 flex items-center justify-between">
                <h1 className="text-2xl font-semibold text-slate-900">Inventory</h1>
                {canCreate && (
                    <button
                        type="button"
                        onClick={() => setCreateOpen(true)}
                        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
                    >
                        + New Record
                    </button>
                )}
            </div>
            <ErrorBanner message={error} />

            {loading ? (
                <p className="text-sm text-slate-500">Loading…</p>
            ) : rows.length === 0 ? (
                <EmptyState message="No inventory records found" />
            ) : (
                <DataTable columns={columns} rows={displayRows} />
            )}

            {canCreate && (
                <Modal open={createOpen} title="Create Inventory Record" onClose={closeCreateModal}>
                    <form onSubmit={handleCreate}>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <label htmlFor="inventory-item" className="mb-1 block text-sm font-medium text-slate-700">
                                    Item
                                </label>
                                <select
                                    id="inventory-item"
                                    value={formItem}
                                    onChange={(event) => setFormItem(event.target.value)}
                                    required
                                    className={inputClass}
                                >
                                    <option value="" disabled>
                                        Select an item…
                                    </option>
                                    {items.map((item) => (
                                        <option key={item.id} value={item.id}>
                                            {item.code} - {item.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label htmlFor="inventory-location" className="mb-1 block text-sm font-medium text-slate-700">
                                    Location
                                </label>
                                <select
                                    id="inventory-location"
                                    value={formLocation}
                                    onChange={(event) => setFormLocation(event.target.value)}
                                    required
                                    className={inputClass}
                                >
                                    <option value="" disabled>
                                        Select a location…
                                    </option>
                                    {locations.map((location) => (
                                        <option key={location.id} value={location.id}>
                                            {location.code} - {location.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label htmlFor="inventory-batch" className="mb-1 block text-sm font-medium text-slate-700">
                                    Batch
                                </label>
                                <input
                                    id="inventory-batch"
                                    type="text"
                                    value={formBatch}
                                    onChange={(event) => setFormBatch(event.target.value)}
                                    required
                                    className={inputClass}
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="inventory-physical-quantity"
                                    className="mb-1 block text-sm font-medium text-slate-700"
                                >
                                    Physical Quantity
                                </label>
                                <input
                                    id="inventory-physical-quantity"
                                    type="number"
                                    min="0"
                                    value={formPhysicalQuantity}
                                    onChange={(event) => setFormPhysicalQuantity(event.target.value)}
                                    required
                                    className={inputClass}
                                />
                            </div>
                        </div>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={closeCreateModal}
                                disabled={creating}
                                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={creating}
                                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {creating ? 'Creating…' : 'Create Record'}
                            </button>
                        </div>
                    </form>
                </Modal>
            )}
        </main>
    );
}
