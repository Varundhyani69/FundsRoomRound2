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
        <table>
            <thead>
                <tr>
                    {columns.map((column) => (
                        <th key={column.key}>{column.label}</th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {rows.map((row, index) => (
                    <tr key={row.id ?? index}>
                        {columns.map((column) => (
                            <td key={column.key}>{row[column.key]}</td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
