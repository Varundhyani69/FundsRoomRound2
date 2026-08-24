// Transfer controller: list, create, dispatch, and receive handlers for internal transfers.

const transferService = require('../services/transfer.service');

/** GET /api/transfers */
async function listTransfers(req, res, next) {
    const { status } = req.validated.query;

    try {
        const transfers = await transferService.listTransfers({ status });
        return res.status(200).json(transfers);
    } catch (error) {
        // Express 4 does not observe a rejected promise
        return next(error);
    }
}

/** POST /api/transfers */
async function createTransfer(req, res, next) {
    const { item, batch, sourceLocation, destinationLocation, quantity } = req.validated.body;

    try {
        const created = await transferService.createTransfer({
            item,
            batch,
            sourceLocation,
            destinationLocation,
            quantity,
        });
        return res.status(201).json(created);
    } catch (error) {
        return next(error);
    }
}

/** POST /api/transfers/:id/dispatch */
async function dispatchTransfer(req, res, next) {
    const { id } = req.validated.params;

    try {
        const transfer = await transferService.dispatchTransfer(id);
        return res.status(200).json(transfer);
    } catch (error) {
        return next(error);
    }
}

/** POST /api/transfers/:id/receive */
async function receiveTransfer(req, res, next) {
    const { id } = req.validated.params;

    try {
        const transfer = await transferService.receiveTransfer(id);
        return res.status(200).json(transfer);
    } catch (error) {
        return next(error);
    }
}

module.exports = { listTransfers, createTransfer, dispatchTransfer, receiveTransfer };
