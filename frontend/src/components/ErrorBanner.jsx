// frontend/src/components/ErrorBanner.jsx -- displays the `message` field
// of a rejected API response on the screen that issued the request, while
// every previously displayed value stays as it was (Req 11.12). Renders
// nothing when there is no message, so screens can render it unconditionally
// alongside their data.

export default function ErrorBanner({ message }) {
    if (!message) {
        return null;
    }

    return <p role="alert">{message}</p>;
}
