// frontend/src/components/StatusBadge.jsx -- a small colored chip for a status value.
// Renders exactly the status text passed in (no relabeling), just with color to make
// scanning a table of many rows faster. Falls back to a neutral gray for any status
// string not in the map, so a future enum value never renders unstyled or throws.

const COLOR_BY_STATUS = {
    // WorkOrder
    Assigned: 'bg-amber-100 text-amber-800',
    InProgress: 'bg-blue-100 text-blue-800',
    Completed: 'bg-emerald-100 text-emerald-800',
    // InternalTransfer
    Requested: 'bg-amber-100 text-amber-800',
    Dispatched: 'bg-blue-100 text-blue-800',
    Received: 'bg-emerald-100 text-emerald-800',
    // CustomerOrder
    Reserved: 'bg-blue-100 text-blue-800',
    Cancelled: 'bg-slate-200 text-slate-600',
};

const DEFAULT_COLOR = 'bg-slate-100 text-slate-700';

export default function StatusBadge({ status }) {
    const color = COLOR_BY_STATUS[status] || DEFAULT_COLOR;
    return (
        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
            {status}
        </span>
    );
}
