// frontend/src/components/Modal.jsx -- a small, generic modal dialog shared by
// every screen's creation form.
//
// Exists so a creation form is not permanently rendered above its screen's
// list (pushing the data a person actually came to see below the fold on
// every visit) -- instead each screen renders one "+ New ..." button, and the
// form only appears, as a popup, while that button's modal is open.
//
// Closes on Escape, on a backdrop click, and via its own close button, all
// three calling the same onClose. Renders nothing when `open` is false, so a
// closed modal costs nothing and (more importantly for the screens that use
// this) never keeps its form's controlled inputs mounted -- but callers still
// own the form's field state so a value is not lost if the modal is closed and
// reopened by accident; only Cancel/successful submit resets a form's fields.

import { useEffect } from 'react';

export default function Modal({ open, title, onClose, children }) {
    useEffect(() => {
        if (!open) return undefined;

        function handleKeyDown(event) {
            if (event.key === 'Escape') {
                onClose();
            }
        }

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open, onClose]);

    if (!open) {
        return null;
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={(event) => event.stopPropagation()}
                className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl"
            >
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-base font-semibold text-slate-900">{title}</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    >
                        ✕
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}
