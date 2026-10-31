'use strict';

// Read-only runtime configuration bridge for the Electron
// development launcher. Does not start processes or change data.

const fs = require('fs');
const path = require('path');

const PORTS = Object.freeze({
    owner: 15300,
    public: 15302,
    ipfs_api: 15301,
    ipfs_gateway: 18081,
    ipfs_swarm: 14001,
    tor_control: 19351,
    tor_socks: 19350
});


function loadDevelopmentRuntime(rootDirectory) {
    const root = fs.realpathSync(rootDirectory);
    const workspace = path.join(
        root,
        '.fileshare-dev'
    );

    const expectedPaths = {
        workspace,
        database: path.join(
            workspace,
            'state',
            'metadata.db'
        ),
        ipfs_repo: path.join(
            workspace,
            'ipfs'
        ),
        tor_data: path.join(
            workspace,
            'tor',
            'data'
        ),
        torrc: path.join(
            workspace,
            'tor',
            'torrc'
        ),
        logs: path.join(
            workspace,
            'logs'
        ),
        temporary: path.join(
            workspace,
            'temporary'
        )
    };

    if (
        !fs.existsSync(
            path.join(root, 'package.json')
        ) ||
        !fs.existsSync(
            path.join(
                root,
                'server',
                'server_persistent.py'
            )
        )
    ) {
        throw new Error(
            'Not a FileShare source checkout'
        );
    }

    const manifest = path.join(
        workspace,
        'runtime.json'
    );

    const config = JSON.parse(
        fs.readFileSync(
            manifest,
            'utf8'
        )
    );

    if (
        config.version !== 1 ||
        config.profile !== 'development' ||
        config.project_root !== root ||
        JSON.stringify(config.ports) !==
            JSON.stringify(PORTS)
    ) {
        throw new Error(
            'Unexpected FileShare development profile or ports'
        );
    }

    for (
        const [name, requiredPath]
        of Object.entries(expectedPaths)
    ) {
        if (
            config.paths?.[name] !== requiredPath
        ) {
            throw new Error(
                `Unexpected development path: ${name}`
            );
        }

        if (
            fs.existsSync(requiredPath) &&
            fs.realpathSync(requiredPath) !== requiredPath
        ) {
            throw new Error(
                `Symlink/redirected development path: ${name}`
            );
        }
    }

    if (
        Object.keys(config.paths).length !==
        Object.keys(expectedPaths).length
    ) {
        throw new Error(
            'Unexpected extra development paths'
        );
    }

    for (const name of [
        'workspace',
        'ipfs_repo',
        'tor_data',
        'logs',
        'temporary'
    ]) {
        if (
            !fs.statSync(
                expectedPaths[name]
            ).isDirectory()
        ) {
            throw new Error(
                `Development directory missing: ${name}`
            );
        }
    }

    const torrc = [
        `DataDirectory "${
            expectedPaths.tor_data.replace(/\\/g, '/')
        }"`,
        'CookieAuthentication 1',
        `ControlPort 127.0.0.1:${PORTS.tor_control}`,
        `SocksPort 127.0.0.1:${PORTS.tor_socks}`,
        'Log notice stdout',
        ''
    ].join('\n');

    if (
        fs.readFileSync(
            expectedPaths.torrc,
            'utf8'
        ).replace(/\r\n/g, '\n') !== torrc
    ) {
        throw new Error(
            'Unexpected Tor configuration'
        );
    }

    return Object.freeze({
        root,
        ...expectedPaths,
        ports: PORTS,
        ownerURL: (
            `http://127.0.0.1:${PORTS.owner}`
        ),
        publicURL: (
            `http://127.0.0.1:${PORTS.public}`
        ),
        ipfsAPI: (
            `http://127.0.0.1:${PORTS.ipfs_api}/api/v0`
        )
    });
}


module.exports = {
    loadDevelopmentRuntime,
    PORTS
};


if (require.main === module) {
    try {
        const root = (
            process.argv[2] ||
            path.resolve(__dirname, '..')
        );

        const config = loadDevelopmentRuntime(
            root
        );

        process.stdout.write(
            `Development configuration: OK\n` +
            `Owner: ${config.ownerURL}\n` +
            `Public: ${config.publicURL}\n` +
            `IPFS API: ${config.ipfsAPI}\n` +
            `No processes were started. ` +
            `No files were changed.\n`
        );

    } catch (err) {
        process.stderr.write(
            `Development configuration FAILED: ` +
            `${err.message}\n`
        );

        process.exitCode = 1;
    }
}