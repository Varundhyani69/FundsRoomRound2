// backend/src/services/workOrder.service.js -- the Work_Order_Service: creates Work_Orders,
// reads them with a freshly derived Shortage_Quantity, and advances Work_Order_Status through
// one guarded transition function (Req 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.12,
// 15.5).
//
// There is no transaction here: creating a Work_Order is a single-document insert with no
// ledger row to write alongside it, unlike inventory.service.js's applyMovement (Req 5.1).
//
// Shortage_Quantity is never stored (see models/WorkOrder.js). It is computed fresh on every
// read from the InventoryRecord documents current at that read, via
// `locationAvailableQuantity` from availability.js -- the single source of truth for
// availability (Req 5.4, 15.1).
//
// `nextWorkOrderStatus` is the one place the Assigned -> InProgress -> Completed transition
// rule lives (Req 5.8, 15.5). `changeStatus` is its only caller in this file, and no other
// module compares Work_Order_Status inline.

const WorkOrder = require('../models/WorkOrder');
const InventoryRecord = require('../models/InventoryRecord');
const Item = require('../models/Item');
const Location = require('../models/Location');
const User = require('../models/User');
const { locationAvailableQuantity } = require('./availability');
const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');

// Built fresh per call, the same way inventory.service.js's error factories are, so each
// thrown error carries its own stack.
const invalidReference = () =>
    new AppError(
        ERROR_CODES.INVALID_REFERENCE,
        'INVALID_REFERENCE',
        'The referenced location, item, or assigned user does not exist.'
    );

const notFound = () =>
    new AppError(ERROR_CODES.NOT_FOUND, 'NOT_FOUND', 'Work order not found.');

const invalidStatusTransition = () =>
    new AppError(
        ERROR_CODES.INVALID_STATUS_TRANSITION,
        'INVALID_STATUS_TRANSITION',
        'This status change is not the successor of the current status.'
    );

// The one Work_Order_Status transition rule, expressed as "current -> its one legal
// successor" (Req 5.8). Nothing is a legal successor of the terminal `Completed`, so it has
// no entry and every target requested from it fails the lookup below.
const LEGAL_SUCCESSOR = {
    Assigned: 'InProgress',
    InProgress: 'Completed',
};

/**
 * The named guard that decides whether a Work_Order_Status change is legal: only the
 * immediate successor in the order `Assigned` -> `InProgress` -> `Completed` is legal.
 * Same-status, backward, skip-ahead, and any transition away from the terminal `Completed`
 * are all illegal (Req 5.9). This is the one place that rule lives; `changeStatus` below is
 * its only caller (Req 5.8, 15.5).
 *
 * @param {string} currentStatus one of 'Assigned', 'InProgress', 'Completed'
 * @param {string} targetStatus one of 'Assigned', 'InProgress', 'Completed'
 * @returns {boolean} true only when `targetStatus` is the immediate successor of `currentStatus`
 */
function nextWorkOrderStatus(currentStatus, targetStatus) {
    return LEGAL_SUCCESSOR[currentStatus] === targetStatus;
}

/**
 * Populates a WorkOrder document the same way for create, list, and get, so the response
 * shape never drifts between endpoints.
 *
 * @param {import('mongoose').Query} query
 * @returns {import('mongoose').Query}
 */
function populateWorkOrder(query) {
    return query
        .populate({ path: 'item', populate: { path: 'category' } })
        .populate('location')
        .populate('assignedUser', 'email role');
}

/**
 * Computes the Location_Available_Quantity and Shortage_Quantity of one Work_Order at read
 * time, treating the Location_Available_Quantity as 0 when no InventoryRecord exists for
 * that item and location (Req 5.4, 5.5, 5.6, 5.10).
 *
 * @param {import('mongoose').Document} workOrder a populated WorkOrder document
 * @returns {Promise<{ locationAvailableQuantity: number, shortageQuantity: number }>}
 */
async function computeShortage(workOrder) {
    const records = await InventoryRecord.find({
        item: workOrder.item._id,
        location: workOrder.location._id,
    });

    const available = locationAvailableQuantity(records);
    const shortage = Math.max(0, workOrder.requiredQuantity - available);

    return { locationAvailableQuantity: available, shortageQuantity: shortage };
}

/**
 * Creates a Work_Order with Work_Order_Status `Assigned` (Req 5.1).
 *
 * @param {{ location: string, item: string, requiredQuantity: number, assignedUser: string, createdBy: string }} input
 * @returns {Promise<import('mongoose').Document>} the created, populated WorkOrder document
 * @throws {AppError} 400 INVALID_REFERENCE when location, item, or assignedUser does not exist
 */
async function createWorkOrder({ location, item, requiredQuantity, assignedUser, createdBy }) {
    const [locationExists, itemExists, assignedUserExists] = await Promise.all([
        Location.exists({ _id: location }),
        Item.exists({ _id: item }),
        User.exists({ _id: assignedUser }),
    ]);
    if (!locationExists || !itemExists || !assignedUserExists) {
        throw invalidReference();
    }

    const created = await WorkOrder.create({
        location,
        item,
        requiredQuantity,
        assignedUser,
        status: 'Assigned',
        createdBy,
    });

    return populateWorkOrder(WorkOrder.findById(created._id));
}

/**
 * Lists WorkOrders, optionally filtered by status and/or location, each with its freshly
 * derived Location_Available_Quantity and Shortage_Quantity (Req 5.4).
 *
 * @param {{ status?: string, location?: string }} [filters]
 * @returns {Promise<Array<import('mongoose').Document & { locationAvailableQuantity: number, shortageQuantity: number }>>}
 */
async function listWorkOrders({ status, location } = {}) {
    const filter = {};
    if (status) filter.status = status;
    if (location) filter.location = location;

    const workOrders = await populateWorkOrder(WorkOrder.find(filter));

    return Promise.all(
        workOrders.map(async (workOrder) => {
            const shortage = await computeShortage(workOrder);
            return Object.assign(workOrder, shortage);
        })
    );
}

/**
 * Reads one Work_Order with its freshly derived Location_Available_Quantity and
 * Shortage_Quantity (Req 5.4).
 *
 * @param {string} id
 * @returns {Promise<import('mongoose').Document & { locationAvailableQuantity: number, shortageQuantity: number }>}
 * @throws {AppError} 404 NOT_FOUND when no Work_Order matches `id`
 */
async function getWorkOrder(id) {
    const workOrder = await populateWorkOrder(WorkOrder.findById(id));
    if (!workOrder) {
        throw notFound();
    }

    const shortage = await computeShortage(workOrder);
    return Object.assign(workOrder, shortage);
}

/**
 * Advances a Work_Order's status through the one guarded transition function
 * (`nextWorkOrderStatus`), recording `statusChangedAt` on success (Req 5.7, 5.8, 5.9).
 *
 * @param {{ id: string, targetStatus: string }} input
 * @returns {Promise<import('mongoose').Document>} the updated WorkOrder document
 * @throws {AppError} 404 NOT_FOUND when no Work_Order matches `id`; 409
 *   INVALID_STATUS_TRANSITION when `targetStatus` is not the legal successor
 */
async function changeStatus({ id, targetStatus }) {
    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
        throw notFound();
    }

    if (!nextWorkOrderStatus(workOrder.status, targetStatus)) {
        throw invalidStatusTransition();
    }

    workOrder.status = targetStatus;
    workOrder.statusChangedAt = new Date();
    await workOrder.save();

    return workOrder;
}

module.exports = {
    nextWorkOrderStatus,
    createWorkOrder,
    listWorkOrders,
    getWorkOrder,
    changeStatus,
};
