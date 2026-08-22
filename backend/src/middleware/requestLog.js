// backend/src/middleware/requestLog.js -- mounted early, third in the pipeline.
// One line on standard output per finished response holding the request method,
// the request path, the resulting HTTP status, and the error code when the status
// is 400 or above (Req 9.8).

const ERROR_STATUS_FLOOR = 400;

function requestLog(req, res, next) {
    const method = req.method;
    // originalUrl is the path as requested, unaffected by later router mounting.
    const path = req.originalUrl.split('?')[0];

    // 'finish' fires once the response has been written, which is the only moment
    // the final status and the error code are both known. next() is called
    // immediately so the middleware never delays the request.
    res.on('finish', () => {
        const status = res.statusCode;
        // errorHandler records the code it sent on res.locals before responding.
        const code = res.locals.errorCode;
        const line =
            status >= ERROR_STATUS_FLOOR && code
                ? `${method} ${path} ${status} ${code}`
                : `${method} ${path} ${status}`;
        console.log(line);
    });

    next();
}

module.exports = requestLog;
