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
import DataTable from '../components/DataTable.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import EmptyState from '../components/EmptyState.jsx';

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
        status: transfer.status,
    };
}

export default function TransfersScreen() {
    const { role } = useAuth();
    const [rows, setRows] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    const [form, setForm] = useState(EMPTY_FORM);
    const [creating, setCreating] = useState(false);

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
            await load(); // refetch after a successful write (Req 11.14)
        } catch (err) {
            setError(err.message);
        } finally {
            setCreating(false);
        }
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

    const displayRows = showActionsColumn
        ? rows.map((row) => ({
            ...row,
            // Dispatch appears only on `Requested` rows, receive only on
            // `Dispatched` rows, and neither on `Received` rows -- so a
            // row in the terminal status renders no button.
            actions: (
                <>
                    {canDispatch && row.status === 'Requested' && (
                        <button
                            type="button"
                            disabled={busyAction?.id === row.id && busyAction.action === 'dispatch'}
                            onClick={() => handleDispatch(row.id)}
                        >
                            Dispatch
                        </button>
                    )}
                    {canReceive && row.status === 'Dispatched' && (
                        <button
                            type="button"
                            disabled={busyAction?.id === row.id && busyAction.action === 'receive'}
                            onClick={() => handleReceive(row.id)}
                        >
                            Receive
                        </button>
                    )}
                </>
            ),
        }))
        : rows;

    return (
        <main>
            <h1>Internal Transfers</h1>
            <ErrorBanner message={error} />

            {canCreate && (
                <form onSubmit={handleCreate}>
                    <label>
                        Item
                        <input value={form.item} onChange={handleFieldChange('item')} required />
                    </label>
                    <label>
                        Batch
                        <input value={form.batch} onChange={handleFieldChange('batch')} required />
                    </label>
                    <label>
                        Source Location
                        <input value={form.sourceLocation} onChange={handleFieldChange('sourceLocation')} required />
                    </label>
                    <label>
                        Destination Location
                        <input
                            value={form.destinationLocation}
                            onChange={handleFieldChange('destinationLocation')}
                            required
                        />
                    </label>
                    <label>
                        Quantity
                        <input
                            type="number"
                            value={form.quantity}
                            onChange={handleFieldChange('quantity')}
                            required
                        />
                    </label>
                    <button type="submit" disabled={creating}>
                        Create Transfer
                    </button>
                </form>
            )}

            {loading ? (
                <p>Loading…</p>
            ) : rows.length === 0 ? (
                <EmptyState message="No internal transfers found" />
            ) : (
                <DataTable columns={columns} rows={displayRows} />
            )}
        </main>
    );
}
