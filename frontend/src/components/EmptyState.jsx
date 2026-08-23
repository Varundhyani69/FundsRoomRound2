// frontend/src/components/EmptyState.jsx -- shown instead of a data table
// when a list request returns zero records (Req 11.15).

export default function EmptyState({ message = 'No records found' }) {
    return (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
            <p className="text-sm text-slate-500">{message}</p>
        </div>
    );
}
