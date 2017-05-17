import fs from 'fs';
import _ from 'underscore';
import { expect } from 'chai';
import sinon from 'sinon';
import tmp from 'tmp';
import Promise from 'bluebird';

/* global process */

// TODO: override console.log() to test the error messages (now they are printed to console)
// TODO: test callback version of functions!!!

// NOTE: use require() here because this is how its done in acts
const Apifier = process.env.TEST_BABEL_BUILD ? require('../build/index') : require('../src/index');

if (process.env.TEST_BABEL_BUILD) console.log('Running with TEST_BABEL_BUILD option');


/*
let freePorts = [];
before(() => {
    // find free ports for testing
    return portastic.find({
        min: 50000,
        max: 51000,
    })
    .then((ports) => {
        freePorts = ports;
    });
});
const popFreePort = () => freePorts.pop();
*/

const createWatchFile = () => {
    const tmpobj = tmp.fileSync();
    const path = tmpobj.name;
    fs.writeSync(tmpobj.fd, 'bla bla bla bla');

    const stat = fs.statSync(path);
    expect(stat.size).to.be.greaterThan(0);
    return path;
};

const testWatchFileWillBecomeEmpty = (path, waitMillis) => {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const intervalId = setInterval(() => {
            const stat = fs.statSync(path);
            if (stat.size !== 0) {
                if (Date.now() - startedAt >= waitMillis) reject(`Watch file not written in ${waitMillis} millis`);
            } else {
                clearInterval(intervalId);
                resolve();
            }
        }, 20);
    });
};

/*
const testMain = (method, bodyRaw, contentType, userFunc, expectedExitCode = 0) => {
    const port = popFreePort();
    process.env.APIFY_INTERNAL_PORT = port;
    process.env.APIFY_WATCH_FILE = createWatchFile();

    // intercept calls to process.exit()
    const EMPTY_EXIT_CODE = 'dummy';
    let exitCode = EMPTY_EXIT_CODE;
    process.exit = (code) => {
        exitCode = code;
    };

    return new Promise((resolve, reject) => {
        let expectedBody = bodyRaw;
        if (contentType === 'application/json') expectedBody = JSON.parse(bodyRaw);

        // give server a little time to start listening before sending the request
        setTimeout(() => {
            const req = {
                url: `http://127.0.0.1:${port}/`,
                method,
                body: bodyRaw,
                headers: {},
                timeout: 1000,
            };
            if (contentType) req.headers['Content-Type'] = contentType;

            request(req, (err) => {
                if (err) return reject(err);
            });
        }, 20);

        Apifier.main((opts) => {
            // console.dir(opts);
            try {
                expect(opts.input.method).to.equal(method);
                if (contentType) expect(opts.input.contentType).to.equal(contentType);
                expect(opts.input.body).to.deep.equal(expectedBody);
                resolve();
            } catch (err) {
                reject(err);
            }
            // call user func to test other behavior
            if (userFunc) userFunc(opts);
        });
    })
    .then(() => {
        // watch file should be empty by now
        return testWatchFileWillBecomeEmpty(process.env.APIFY_WATCH_FILE, 0);
    })
    .then(() => {
        // test process exit code is as expected
        return new Promise((resolve, reject) => {
            const intervalId = setInterval(() => {
                if (exitCode === EMPTY_EXIT_CODE) return;
                clearInterval(intervalId);
                // restore process.exit()
                process.exit = origProcessExit;
                try {
                    expect(exitCode).to.equal(expectedExitCode);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }, 20);
        });
    });
};
*/

/**
 * Helper function that enables testing of Apifier.main()
 * @return Promise
 */
const testMain = ({ userFunc, context, exitCode, mockInputException, mockOutputException, expectedOutput }) => {
    // Mock process.exit() to check exit code and prevent process exit
    const processMock = sinon.mock(process);
    const exitExpectation = processMock
        .expects('exit')
        .withExactArgs(exitCode)
        .once()
        .returns();

    // Mock Apifier.client.keyValueStores.getRecord() to test act input
    const kvStoresMock = sinon.mock(Apifier.client.keyValueStores);
    if (mockInputException) {
        kvStoresMock
            .expects('getRecord')
            .throws(mockInputException);
    } else if (context.defaultKeyValueStoreId) {
        kvStoresMock
            .expects('getRecord')
            .withExactArgs({
                storeId: context.defaultKeyValueStoreId,
                promise: Apifier.getPromisesDependency(),
                recordKey: 'INPUT',
            })
            .returns(Promise.resolve(context.input))
            .once();
    } else {
        kvStoresMock
            .expects('putRecord')
            .never();
    }

    // Mock Apifier.client.keyValueStores.putRecord() to test act output
    if (mockOutputException) {
        kvStoresMock
            .expects('putRecord')
            .throws(mockOutputException);
    } else if (context.defaultKeyValueStoreId && expectedOutput) {
        kvStoresMock
            .expects('putRecord')
            .withExactArgs({
                storeId: context.defaultKeyValueStoreId,
                promise: Apifier.getPromisesDependency(),
                recordKey: 'OUTPUT',
                contentType: expectedOutput.contentType,
                body: expectedOutput.body,
            })
            .returns(Promise.resolve())
            .once();
    } else {
        kvStoresMock
            .expects('putRecord')
            .never();
    }

    // Mock APIFY_ environment variables
    _.defaults(context, getEmptyContext());
    setContextToEnv(context);

    let error = null;

    return Promise.resolve()
        .then(() => {
            return new Promise((resolve, reject) => {
                // Invoke main() function, the promise resolves after the user function is run
                // Note that if mockInputException is set, then user function will never get called!
                if (!mockInputException) {
                    Apifier.main((realContext) => {
                        try {
                            expect(realContext).to.eql(context);
                            // Wait for all tasks in Node.js event loop to finish
                            resolve();
                        } catch (err) {
                            reject(err);
                            return;
                        }
                        // Call user func to test other behavior (note that it can throw)
                        if (userFunc) return userFunc(realContext);
                    });
                } else {
                    Apifier.main(() => {});
                    resolve();
                }
            });
        })
        .catch((err) => {
            error = err;
        })
        .then(() => {
            // Waits max 1000 millis for process.exit() mock to be called
            // console.log(`XXX: grand finale: ${err}`);
            return new Promise((resolve) => {
                const waitUntil = Date.now() + 1000;
                const intervalId = setInterval(() => {
                    // console.log('test for exitExpectation.called');
                    if (!exitExpectation.called && Date.now() < waitUntil) return;
                    clearInterval(intervalId);
                    // console.log(`exitExpectation.called: ${exitExpectation.called}`);
                    resolve();
                }, 10);
            });
        })
        .then(() => {
            if (error) throw error;
            processMock.verify();
            kvStoresMock.verify();
        })
        .finally(() => {
            processMock.restore();
            kvStoresMock.restore();
        });
};


const getEmptyContext = () => {
    return {
        internalPort: null,
        actId: null,
        actRunId: null,
        startedAt: null,
        timeoutAt: null,
        defaultKeyValueStoreId: null,
        input: null,
    };
};

const setContextToEnv = (context) => {
    delete process.env.APIFY_INTERNAL_PORT;
    delete process.env.APIFY_ACT_ID;
    delete process.env.APIFY_ACT_RUN_ID;
    delete process.env.APIFY_STARTED_AT;
    delete process.env.APIFY_TIMEOUT_AT;
    delete process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID;

    if (context.internalPort) process.env.APIFY_INTERNAL_PORT = context.internalPort.toString();
    if (context.actId) process.env.APIFY_ACT_ID = context.actId;
    if (context.actRunId) process.env.APIFY_ACT_RUN_ID = context.actRunId;
    if (context.startedAt) process.env.APIFY_STARTED_AT = context.startedAt.toISOString();
    if (context.timeoutAt) process.env.APIFY_TIMEOUT_AT = context.timeoutAt.toISOString();
    if (context.defaultKeyValueStoreId) process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID = context.defaultKeyValueStoreId;
};

describe('Apifier.getContext()', () => {
    it('works with null values', () => {
        const expectedContext = getEmptyContext();
        setContextToEnv(expectedContext);

        return Apifier.getContext()
            .then((context) => {
                expect(context).to.eql(expectedContext);
            });
    });

    it('works with with non-null values / no input', () => {
        const expectedContext = _.extend(getEmptyContext(), {
            internalPort: 12345,
            actId: 'test actId',
            actRunId: 'test actId',
            startedAt: new Date('2017-01-01'),
            timeoutAt: new Date(),
            defaultKeyValueStoreId: null,
            input: null,
        });
        setContextToEnv(expectedContext);

        return Apifier.getContext()
            .then((context) => {
                expect(context).to.eql(expectedContext);
            });
    });

    it('works with callbacks', () => {
        const expectedContext = _.extend(getEmptyContext(), {
            internalPort: 4455,
            actId: 'test actId x',
            actRunId: 'test actId x',
            startedAt: new Date('2017-01-01'),
            timeoutAt: new Date(),
        });
        setContextToEnv(expectedContext);

        return new Promise((resolve, reject) => {
            Apifier.getContext((err, context) => {
                if (err) reject(err);
                resolve(context);
            });
        })
        .then((context) => {
            expect(context).to.eql(expectedContext);
        });
    });

    it('works with with non-null values / text input', () => {
        const expectedContext = {
            internalPort: 12345,
            actId: 'test actId',
            actRunId: 'test actId',
            startedAt: new Date('2017-01-01'),
            timeoutAt: new Date(),
            defaultKeyValueStoreId: 'test storeId',
            input: {
                body: 'test body',
                contentType: 'text/plain',
            },
        };
        setContextToEnv(expectedContext);

        const mock = sinon.mock(Apifier.client.keyValueStores);
        const expectation = mock.expects('getRecord');
        expectation
            .withExactArgs({
                storeId: expectedContext.defaultKeyValueStoreId,
                promise: Apifier.getPromisesDependency(),
                recordKey: 'INPUT',
            })
            .once()
            .returns(Promise.resolve(expectedContext.input));

        return Promise.resolve()
            .then(() => {
                return Apifier.getContext();
            })
            .then((context) => {
                expect(context).to.eql(expectedContext);
                expectation.verify();
            })
            .finally(() => {
                mock.restore();
            });
    });
});

describe('Apifier.getInput()', () => {
    it('supports both promises and callbacks (on success)', () => {
        const mock = sinon.mock(Apifier.client.keyValueStores);
        mock.expects('getRecord')
            .twice()
            .returns(Promise.resolve(null));

        return Promise.resolve()
            .then(() => {
                // test promise
                return Apifier.getInput();
            })
            .then((input) => {
                expect(input).to.be.eql(null);
            })
            .then(() => {
                // test callback
                return new Promise((resolve, reject) => {
                    return Apifier.getInput((err, input) => {
                        if (err) return reject(err);
                        resolve(input);
                    });
                });
            })
            .then((input) => {
                expect(input).to.be.eql(null);

                mock.verify();
            })
            .finally(() => {
                mock.restore();
            });
    });

    it('supports both promises and callbacks (on error)', () => {
        const mock = sinon.mock(Apifier.client.keyValueStores);
        mock.expects('getRecord')
            .twice()
            .throws(new Error('Test error'));

        return Promise.resolve()
            .then(() => {
                // test promise
                return Apifier.getInput();
            })
            .catch((err) => {
                expect(err.message).to.be.eql('Test error');
            })
            .then(() => {
                // test callback
                return new Promise((resolve, reject) => {
                    return Apifier.getInput((err, input) => {
                        if (err) return reject(err);
                        resolve(input);
                    });
                });
            })
            .catch((err) => {
                expect(err.message).to.be.eql('Test error');
            })
            .then(() => {
                mock.verify();
            })
            .finally(() => {
                mock.restore();
            });
    });

    it('returns null on undefined keyValueStores.getRecord() result', () => {
        const mock = sinon.mock(Apifier.client.keyValueStores);
        mock.expects('getRecord')
            .once()
            .returns(Promise.resolve(undefined));

        return Promise.resolve()
            .then(() => {
                return Apifier.getInput();
            })
            .then((input) => {
                expect(input).to.be.eql(null);
                mock.verify();
            })
            .finally(() => {
                mock.restore();
            });
    });

    it('fails on invalid keyValueStores.getRecord() result', () => {
        const mock = sinon.mock(Apifier.client.keyValueStores);
        mock.expects('getRecord')
            .once()
            .returns(Promise.resolve({ invalid: 'bla bla' }));

        return Promise.resolve()
            .then(() => {
                return Apifier.getInput();
            })
            .then(() => {
                expect.fail();
            })
            .catch((err) => {
                expect(err.message).to.contain('ApifyClient returned an unexpected value');
            })
            .then(() => {
                mock.verify();
            })
            .finally(() => {
                mock.restore();
            });
    });
});

describe('Apifier.main()', () => {
    it('throws on invalid args', () => {
        expect(() => {
            Apifier.main();
        }).to.throw(Error);
    });

    it('works with simple user function', () => {
        return testMain({
            userFunc: () => {},
            context: {},
            exitCode: 0,
        });
    });

    it('works with promised user function', () => {
        let called = false;
        return testMain({
            userFunc: () => {
                return new Promise((resolve) => {
                    setTimeout(() => {
                        called = true;
                        // console.log('called = true');
                        resolve();
                    }, 20);
                });
            },
            context: {},
            exitCode: 0,
        })
        .then(() => {
            expect(called).to.eql(true);
        });
    });

    it('gets input correctly', () => {
        const context = {
            defaultKeyValueStoreId: 'test storeId',
            input: {
                body: 'test body',
                contentType: 'text/plain',
            },
        };
        return testMain({
            userFunc: null,
            context,
            exitCode: 0,
        });
    });

    it('sets output from simple user function', () => {
        const context = {
            defaultKeyValueStoreId: 'test storeId x',
        };
        const output = { test: 123 };
        return testMain({
            userFunc: () => {
                return output;
            },
            context,
            exitCode: 0,
            expectedOutput: {
                contentType: 'application/json; charset=utf-8',
                body: JSON.stringify(output),
            },
        });
    });

    it('sets output from promised user function', () => {
        const context = {
            defaultKeyValueStoreId: 'test storeId x',
        };
        const output = { test: 123 };
        return testMain({
            userFunc: () => {
                return Promise.resolve().then(() => {
                    return output;
                });
            },
            context,
            exitCode: 0,
            expectedOutput: {
                contentType: 'application/json; charset=utf-8',
                body: JSON.stringify(output),
            },
        });
    });

    it('on exception in simple user function the process exits with code 1001', () => {
        return testMain({
            userFunc: () => {
                throw new Error('Test exception I');
            },
            context: {},
            exitCode: 91,
        });
    });

    it('on exception in promised user function the process exits with code 1001', () => {
        return testMain({
            userFunc: () => {
                return new Promise((resolve) => {
                    setTimeout(resolve, 20);
                })
                .then(() => {
                    throw new Error('Text exception II');
                });
            },
            context: {},
            exitCode: 91,
        });
    });

    it('on exception in getInput the process exits with code 1002', () => {
        return testMain({
            userFunc: null,
            context: {
                defaultKeyValueStoreId: 'test storeId',
                input: {},
            },
            exitCode: 92,
            mockInputException: new Error('Text exception III'),
        });
    });

    it('on exception in setOutput the process exits with code 1003', () => {
        return testMain({
            userFunc: () => {
                return 'anything';
            },
            context: {
                defaultKeyValueStoreId: 'test storeId',
            },
            exitCode: 93,
            mockOutputException: new Error('Text exception IV'),
        });
    });

    it('on non-JSON-stringifyable return value the process exits with code 1003', () => {
        const circularObj = {};
        circularObj.aaa = circularObj;

        return testMain({
            userFunc: () => {
                return circularObj;
            },
            context: {
                defaultKeyValueStoreId: 'test storeId',
            },
            exitCode: 93,
        });
    });
});


describe('Apifier.setOuput()', () => {
    it('throws on invalid args', () => {
        expect(() => {
            Apifier.setOutput();
        }).to.throw(Error);

        expect(() => {
            Apifier.setOutput('bla bla');
        }).to.throw(Error);

        expect(() => {
            Apifier.setOutput(1234);
        }).to.throw(Error);

        expect(() => {
            Apifier.setOutput({});
        }).to.throw(Error);

        expect(() => {
            Apifier.setOutput({ body: undefined, contentType: 'test' });
        }).to.throw(Error);

        expect(() => {
            Apifier.setOutput({ body: {}, contentType: 456 });
        }).to.throw(Error);

        expect(() => {
            Apifier.setOutput({ body: {}, contentType: undefined });
        }).to.throw(Error);
    });
});


describe('Apifier.events', () => {
    it('is there and works as EventEmitter', () => {
        return new Promise((resolve, reject) => {
            try {
                Apifier.events.on('foo', resolve);
                Apifier.events.emit('foo', 'test event');
            } catch (e) {
                reject(e);
            }
        })
        .then((arg) => {
            expect(arg).to.eql('test event');
        });
    });
});


describe('Apifier.readyFreddy()', () => {
    it('it works as expected', () => {
        process.env.APIFY_WATCH_FILE = createWatchFile();
        Apifier.readyFreddy();
        return testWatchFileWillBecomeEmpty(process.env.APIFY_WATCH_FILE, 1000);
    });
});
