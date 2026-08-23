// frontend/src/components/EmptyState.jsx -- shown instead of a data table
// when a list request returns zero records (Req 11.15).

export default function EmptyState({ message = 'No records found' }) {
    return <p>{message}</p>;
}
