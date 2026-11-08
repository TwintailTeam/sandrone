const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HEAP_LIMIT_MB = 512;

class WorkerError extends Error {
    name = 'WorkerError';
}

if (!isMainThread && workerData?.task) {
    const { module, method, args } = workerData.task;
    Promise.resolve().then(() => require(module)[method](...args)).then((result) => parentPort.postMessage({ ok: true, result })).catch((error) => parentPort.postMessage({ ok: false, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack } }));
}

const running = new Map();

function runInWorker(module, method, args, { transferList = [], timeoutMs = DEFAULT_TIMEOUT_MS, heapLimitMb = DEFAULT_HEAP_LIMIT_MB, concurrency = Infinity } = {}) {
    const key = `${module}#${method}`;
    if ((running.get(key) ?? 0) >= concurrency) { return Promise.reject(new WorkerError('Too many of these jobs are running right now. Try again in a few seconds.')); }
    running.set(key, (running.get(key) ?? 0) + 1);

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let worker = null;

        const finish = (callback, value) => {
            if (settled) { return; }
            settled = true;
            running.set(key, running.get(key) - 1);
            clearTimeout(timer);
            worker?.terminate().catch(() => {});
            callback(value);
        };

        try {
            worker = new Worker(__filename, { workerData: { task: { module, method, args } }, transferList, resourceLimits: { maxOldGenerationSizeMb: heapLimitMb } });
        } catch (error) {
            finish(reject, error);
            return;
        }

        timer = setTimeout(() => finish(reject, new WorkerError(`The job took longer than ${timeoutMs / 1000}s and was stopped.`)), timeoutMs);
        worker.once('message', (message) => {
            if (message.ok) { return finish(resolve, message.result); }
            const error = new Error(message.error.message);
            error.name = message.error.name;
            error.stack = message.error.stack;
            finish(reject, error);
        });
        worker.once('error', (error) => finish(reject, error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new WorkerError('The job needed too much memory and was stopped.') : error));
        worker.once('exit', (code) => finish(reject, new WorkerError(`The job's worker exited unexpectedly (code ${code}).`)));
    });
}

module.exports = { WorkerError, runInWorker };
