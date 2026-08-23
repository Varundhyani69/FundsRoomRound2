// frontend/src/hooks/useReferenceData.js -- loads the read-only reference lists
// (Items, Locations, Users) a write form's dropdowns need, once per screen mount.
//
// This exists because every creation form on Inventory/Work Orders/Transfers/
// Customer Orders asks the caller to name an Item, Location, or (for Work Orders)
// an assigned User by ObjectId -- and a raw 24-character hex text box is not
// something a person can type from memory. GET /api/items, GET /api/locations,
// and GET /api/users already exist for exactly this (backend/src/controllers/
// reference.controller.js), so this hook is the one place that fetches them and
// hands back plain arrays a <select> can map over.
//
// Only the lists a screen actually asks for are fetched -- a screen with no Work
// Order form has no reason to load every User -- so `fetchItems`/`fetchLocations`/
// `fetchUsers` gate each call independently rather than always fetching all three.

import { useEffect, useState } from 'react';
import { get } from '../api/client.js';

/**
 * @param {{ items?: boolean, locations?: boolean, users?: boolean }} [options]
 * @returns {{ items: Array, locations: Array, users: Array, loading: boolean, error: string|null }}
 */
export function useReferenceData({ items: fetchItems = false, locations: fetchLocations = false, users: fetchUsers = false } = {}) {
    const [items, setItems] = useState([]);
    const [locations, setLocations] = useState([]);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                // Each call is only issued when its flag is true; the ones left
                // false resolve immediately with an empty array instead of
                // calling get(), so a screen's reference-data GET count and
                // order matches exactly the flags it passed in.
                const [itemsResult, locationsResult, usersResult] = await Promise.all([
                    fetchItems ? get('/api/items') : Promise.resolve([]),
                    fetchLocations ? get('/api/locations') : Promise.resolve([]),
                    fetchUsers ? get('/api/users') : Promise.resolve([]),
                ]);

                if (!cancelled) {
                    setItems(itemsResult);
                    setLocations(locationsResult);
                    setUsers(usersResult);
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

        load();

        return () => {
            cancelled = true;
        };
    }, [fetchItems, fetchLocations, fetchUsers]);

    return { items, locations, users, loading, error };
}
