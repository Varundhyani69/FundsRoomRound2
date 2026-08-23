// frontend/src/components/ErrorBanner.jsx -- displays the `message` field
// of a rejected API response on the screen that issued the request, while
// every previously displayed value stays as it was (Req 11.12). Renders
// nothing when there is no message, so screens can render it unconditionally
// alongside their data.

export default function ErrorBanner({ message }) {
    if (!message) {
        return null;
    }

    return (
        <p
            role="alert"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
        >
            {message}
        </p>
    );
}
