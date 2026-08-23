// frontend/src/screens/TransfersScreen.jsx -- the Internal Transfers screen.
// Follows the shared screen pattern from InventoryScreen.jsx (design.md
// "Screen pattern"):
//   1. useEffect on mount -> request the list -> rows in local state.
//   2. Zero rows -> <EmptyState /> (Req 11.15).
//   3. Any non-401 error -> <ErrorBanner /> while leaving displayed values
//      untouched (Req 11.12).
//   4. A write control sets busy true, disables itself, and re-enables on
//      response (Req 11.13).
//   5. On write success -> refetch the list and render the refetched
//      values (Req 11.14).
//
// Extended with a creation form and per-row dispatch/receive controls,
// each gated by canWrite() against the role permitted on the corresponding
// write route (design.md "Role gating", Req 11.9).
//
// Columns are exactly id, Source Location, Destination Location, Item,
// Batch, Quantity, Status (Req 11.8), flattening the nested item/
// sourceLocation/destinationLocation objects the API returns.

import { useEffect, useState } from 'react';
import { get, post } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { canWrite } from '../auth/permissions.js';
import { useReferenceData } from '../hooks/useReferenceData.js';
import DataTable from '../components/DataTable.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import Modal from '../components/Modal.jsx';

const COLUMNS = [
    { key: 'id', label: 'ID' },
    { key: 'sourceLocationLabel', label: 'Source Location' },
    { key: 'destinationLocationLabel', label: 'Destination Location' },
    { key: 'itemLabel', label: 'Item' },
    { key: 'batch', label: 'Batch' },
    { key: 'quantity', label: 'Quantity' },
    { key: 'status', label: 'Status' },
];

const EMPTY_FORM = {
    item: '',
    batch: '',
    sourceLocation: '',
    destinationLocation: '',
    quantity: '',
};

// Flattens one populated InternalTransfer response (nested item/
// sourceLocation/destinationLocation objects) into the flat keys DataTable
// renders (Req 11.8).
function toRow(transfer) {
    return {
        id: transfer.id,
        sourceLocationLabel: `${transfer.sourceLocation.code} - ${transfer.sourceLocation.name}`,
        destinationLocationLabel: `${transfer.destinationLocation.code} - ${transfer.destinationLocation.name}`,
        itemLabel: `${transfer.item.code} - ${transfer.item.name}`,
        batch: transfer.batch,
        quantity: transfer.quantity,
        // Kept as the raw enum string here (not a badge element) so the
        // dispatch/receive gating below (`row.rawStatus === 'Requested'`)
        // stays a plain string comparison; the badge is rendered only at
        // display time via `status` in the mapping below.
        rawStatus: transfer.status,
    };
}

export default function TransfersScreen() {
    const { role } = useAuth();
    const [rows, setRows] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    // Item/Location dropdown options for the creation form.
    const { items, locations } = useReferenceData({ items: true, locations: true });

    const [form, setForm] = useState(EMPTY_FORM);
    const [creating, setCreating] = useState(false);
    // Whether the "Create Transfer" popup is open; the form renders only
    // inside <Modal> so it is not pinned above the table.
    const [createOpen, setCreateOpen] = useState(false);

    // The id + action of whichever row control is currently in flight, so
    // only that one control is disabled (Req 11.13) rather than every
    // control on the screen.
    const [busyAction, setBusyAction] = useState(null);

    async function load() {
        try {
            const transfers = await get('/api/transfers');
            setRows(transfers.map(toRow));
            setError(null);
        } catch (err) {
            // Leave any previously displayed rows untouched (Req 11.12).
            setError(err.message);
        }
    }

    useEffect(() => {
        let cancelled = false;

        async function initialLoad() {
            try {
                const transfers = await get('/api/transfers');
                if (!cancelled) {
                    setRows(transfers.map(toRow));
                    setError(null);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err.message);
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        initialLoad();

        return () => {
            cancelled = true;
        };
    }, []);

    function handleFieldChange(field) {
        return (event) => {
            setForm((current) => ({ ...current, [field]: event.target.value }));
        };
    }

    async function handleCreate(event) {
        event.preventDefault();
        setCreating(true);
        try {
            await post('/api/transfers', {
                item: form.item,
                batch: form.batch,
                sourceLocation: form.sourceLocation,
                destinationLocation: form.destinationLocation,
                quantity: Number(form.quantity),
            });
            setForm(EMPTY_FORM);
            setError(null);
            setCreateOpen(false);
            await load(); // refetch after a successful write (Req 11.14)
        } catch (err) {
            setError(err.message);
        } finally {
            setCreating(false);
        }
    }

    function closeCreateModal() {
        setCreateOpen(false);
    }

    async function handleDispatch(id) {
        setBusyAction({ id, action: 'dispatch' });
        try {
            await post(`/api/transfers/${id}/dispatch`, {});
            setError(null);
            await load();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusyAction(null);
        }
    }

    async function handleReceive(id) {
        setBusyAction({ id, action: 'receive' });
        try {
            await post(`/api/transfers/${id}/receive`, {});
            setError(null);
            await load();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusyAction(null);
        }
    }

    const canCreate = canWrite('POST /api/transfers', role);
    const canDispatch = canWrite('POST /api/transfers/:id/dispatch', role);
    const canReceive = canWrite('POST /api/transfers/:id/receive', role);

    // Per-row actions column, added only when the current role can perform
    // at least one of the two actions (Req 11.9). DataTable renders
    // `row[column.key]` directly, so the button element for each row is
    // computed here and stored under the row's `actions` key rather than
    // via a per-column render function.
    const showActionsColumn = canDispatch || canReceive;
    const columns = showActionsColumn ? [...COLUMNS, { key: 'actions', label: 'Actions' }] : COLUMNS;

    const displayRows = rows.map((row) => {
        const displayRow = { ...row, status: <StatusBadge status={row.rawStatus} /> };
        if (!showActionsColumn) {
            return displayRow;
        }
        // Dispatch appears only on `Requested` rows, receive only on
        // `Dispatched` rows, and neither on `Received` rows -- so a
        // row in the terminal status renders no button.
        displayRow.actions = (
            <div className="flex gap-2">
                {canDispatch && row.rawStatus === 'Requested' && (
                    <button
                        type="button"
                        disabled={busyAction?.id === row.id && busyAction.action === 'dispatch'}
                        onClick={() => handleDispatch(row.id)}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        Dispatch
                    </button>
                )}
                {canReceive && row.rawStatus === 'Dispatched' && (
                    <button
                        type="button"
                        disabled={busyAction?.id === row.id && busyAction.action === 'receive'}
                        onClick={() => handleReceive(row.id)}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        Receive
                    </button>
                )}
            </div>
        );
        return displayRow;
    });

    const inputClass =
        'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';
    const labelClass = 'block text-sm font-medium text-slate-700';

    return (
        <main>
            <div className="mb-4 flex items-center justify-between">
                <h1 className="text-2xl font-semibold text-slate-900">Internal Transfers</h1>
                {canCreate && (
                    <button
                        type="button"
                        onClick={() => setCreateOpen(true)}
                        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
                    >
                        + New Transfer
                    </button>
                )}
            </div>
            <ErrorBanner message={error} />

            {loading ? (
                <p className="text-sm text-slate-500">Loading…</p>
            ) : rows.length === 0 ? (
                <EmptyState message="No internal transfers found" />
            ) : (
                <DataTable columns={columns} rows={displayRows} />
            )}

            {canCreate && (
                <Modal open={createOpen} title="Create Transfer" onClose={closeCreateModal}>
                    <form onSubmit={handleCreate}>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <label className={labelClass}>
                                Item
                                <select value={form.item} onChange={handleFieldChange('item')} required className={`mt-1 ${inputClass}`}>
                                    <option value="" disabled>
                                        Select an item…
                                    </option>
                                    {items.map((item) => (
                                        <option key={item.id} value={item.id}>
                                            {item.code} - {item.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className={labelClass}>
                                Batch
                                <input value={form.batch} onChange={handleFieldChange('batch')} required className={`mt-1 ${inputClass}`} />
                            </label>
                            <label className={labelClass}>
                                Source Location
                                <select
                                    value={form.sourceLocation}
                                    onChange={handleFieldChange('sourceLocation')}
                                    required
                                    className={`mt-1 ${inputClass}`}
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
                            </label>
                            <label className={labelClass}>
                                Destination Location
                                <select
                                    value={form.destinationLocation}
                                    onChange={handleFieldChange('destinationLocation')}
                                    required
                                    className={`mt-1 ${inputClass}`}
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
                            </label>
                            <label className={labelClass}>
                                Quantity
                                <input
                                    type="number"
                                    value={form.quantity}
                                    onChange={handleFieldChange('quantity')}
                                    required
                                    className={`mt-1 ${inputClass}`}
                                />
                            </label>
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
                                Create Transfer
                            </button>
                        </div>
                    </form>
                </Modal>
            )}
        </main>
    );
}
