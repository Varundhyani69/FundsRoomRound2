// frontend/src/screens/InventoryScreen.jsx -- the reference implementation
// of the shared screen pattern every other data screen follows
// (design.md "Screen pattern"):
//   1. useEffect on mount -> request the list -> rows in local state.
//   2. Zero rows -> <EmptyState /> (Req 11.15).
//   3. Any non-401 error -> <ErrorBanner /> while leaving displayed values
//      untouched (Req 11.12). client.js already handles 401 globally, so
//      the only errors this screen ever sees are non-401.
//   4-5. No write control on this screen (read-only per design.md's screen
//      list), so there is no busy-disable or refetch-after-write here.
//
// Columns are exactly Item, Category, Location, Batch, Physical Quantity,
// Reserved Quantity, Available Quantity (Req 11.5), with availableQuantity
// taken from the API response rather than recomputed in the browser.

import { useEffect, useState } from 'react';
import { get } from '../api/client.js';
import DataTable from '../components/DataTable.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import EmptyState from '../components/EmptyState.jsx';

const COLUMNS = [
    { key: 'itemLabel', label: 'Item' },
    { key: 'categoryLabel', label: 'Category' },
    { key: 'locationLabel', label: 'Location' },
    { key: 'batch', label: 'Batch' },
    { key: 'physicalQuantity', label: 'Physical Quantity' },
    { key: 'reservedQuantity', label: 'Reserved Quantity' },
    { key: 'availableQuantity', label: 'Available Quantity' },
];

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
    const [rows, setRows] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const records = await get('/api/inventory');
                if (!cancelled) {
                    setRows(records.map(toRow));
                    setError(null);
                }
            } catch (err) {
                // Leave any previously displayed rows untouched (Req 11.12);
                // on first load with no previous data this just means an
                // empty table area behind the error message.
                if (!cancelled) {
                    setError(err.message);
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        load();

        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <main>
            <h1 className="mb-4 text-2xl font-semibold text-slate-900">Inventory</h1>
            <ErrorBanner message={error} />
            {loading ? (
                <p className="text-sm text-slate-500">Loading…</p>
            ) : rows.length === 0 ? (
                <EmptyState message="No inventory records found" />
            ) : (
                <DataTable columns={COLUMNS} rows={rows} />
            )}
        </main>
    );
}
