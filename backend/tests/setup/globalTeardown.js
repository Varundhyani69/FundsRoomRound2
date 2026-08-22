// backend/tests/setup/globalTeardown.js -- stops the in-memory replica set and removes
// the environment handoff file, so the run leaves no mongod process and no stray file.

const fs = require('fs');
const { ENV_FILE } = require('./globalSetup');

module.exports = async () => {
    const replSet = globalThis.__MONGO_REPLSET__;
    if (replSet) {
        await replSet.stop();
        delete globalThis.__MONGO_REPLSET__;
    }

    if (fs.existsSync(ENV_FILE)) {
        fs.unlinkSync(ENV_FILE);
    }
};
