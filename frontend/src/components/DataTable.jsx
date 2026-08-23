// frontend/src/components/DataTable.jsx -- a generic table renderer shared
// by every data screen (design.md "Screen pattern"). Deliberately dumb: no
// sorting, pagination, or filtering, since five simple list screens don't
// need any of that.
//
// `columns` is an array of `{ key, label }`; `rows` is an array of plain
// objects. Each row is rendered by looking up `row[column.key]`, so callers
// are responsible for flattening any nested API response shape into the
// flat keys named in `columns` before passing rows in here.

export default function DataTable({ columns, rows }) {
    return (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50">
                    <tr>
                        {columns.map((column) => (
                            <th
                                key={column.key}
                                className="px-4 py-3 text-left font-semibold uppercase tracking-wide text-xs text-slate-500"
                            >
                                {column.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                    {rows.map((row, index) => (
                        <tr key={row.id ?? index} className="hover:bg-slate-50">
                            {columns.map((column) => (
                                <td key={column.key} className="whitespace-nowrap px-4 py-3 text-slate-700">
                                    {row[column.key]}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
