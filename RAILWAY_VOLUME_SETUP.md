# Setting Up Persistent Storage on Railway

## 1) Create the volume (one-time)

In the Railway dashboard:

1. Open your project
2. Press **⌘K** (Command Palette) or **right-click the project canvas**
3. Choose to create a new **Volume**
4. Select your relay service as the target
5. Set the **Mount Path** to `/data`
6. Restart the service (Railway will prompt you to do this)

That's the entire setup — Railway automatically sets an environment
variable called `RAILWAY_VOLUME_MOUNT_PATH` on your service pointing to
`/data`, which `docker-entrypoint.sh` reads to know where to store
everything.

**One volume per service** is Railway's current limit — this is why
both the Tor hidden service key *and* the reserved future device
registry live under the same `/data` volume, in separate subfolders
(`/data/tor/...` and `/data/registry/...`), rather than as two
separate volumes.

## 2) Redeploy

Push the updated `Dockerfile`, `docker-entrypoint.sh`, and
`torrc.template` (see the accompanying zip), then redeploy as normal.
On this first deploy with the volume attached, Tor will generate a
**brand new** hidden service key inside `/data/tor/d-chat-relay/` —
this will be a **different `.onion` address** than any you tested
locally before, since it's a fresh key on fresh storage. From this
deploy onward, every future redeploy reuses that same key
automatically — the address will no longer change.

## 3) Confirm it's actually persisting

Redeploy a second, trivial time (e.g. push an empty commit) and check
that the `.onion` address in the logs is identical to the previous
deploy:

```bash
railway logs
# look for: [entrypoint] Onion address: xxxxx.onion
```

If it's the same address both times, persistence is working correctly.

## 4) Get the address / inspect the volume without SSH-ing in

Railway's CLI can browse volume contents directly:

```bash
railway volume files --volume <volume-name> browse /
```

Or non-interactively, to grab the onion hostname directly:

```bash
railway volume files --volume <volume-name> browse /tor/d-chat-relay
```

Find your volume's name with:
```bash
railway volume list
```

## 5) Back up the key anyway, as disaster-recovery insurance

Volume persistence across normal redeploys removes the *routine*
manual-backup burden — but it isn't an unconditional guarantee.
Railway's own documentation notes that a deleted volume is only
recoverable for 48 hours before permanent deletion. Treat this exactly
like your APK signing key: back it up once, store it encrypted,
somewhere durable and off this specific Railway project.

```bash
railway volume files --volume <volume-name> download /tor/d-chat-relay/hs_ed25519_secret_key ./onion-key-backup
gpg -c onion-key-backup
# store onion-key-backup.gpg somewhere durable — password manager
# file storage, encrypted external drive, etc.
```

To restore after a disaster (new project, volume was lost, etc.):
decrypt the backup and use `railway volume files upload` to place it
back at the same path *before* the service starts — Tor will detect
and reuse the existing key rather than generating a new one, and the
`.onion` address will be identical to before.

## What changed to make this work correctly

Worth understanding why the file layout looks the way it does: Railway
volumes are **only attached at container runtime, never during the
Docker build step**. The Dockerfile can't set final ownership or
permissions on the volume's contents, because at build time that
directory doesn't exist yet — it's just a normal empty path inside the
image, and gets *replaced* by the real mounted volume once the
container actually starts. All of the directory creation, permission
fixing (`chmod 700` for Tor's key directory specifically — Tor refuses
to start otherwise), and ownership handoff to the unprivileged `relay`
user now happens inside `docker-entrypoint.sh`, which runs *after* the
volume is already mounted. The container intentionally starts as
`root` for this one-time setup step, then drops privileges via
`su-exec` before actually launching Tor or the Node relay — neither
long-running process ever ends up running as root.

## About the reserved `/data/registry` directory

This directory is created and correctly permissioned on every
container start, but nothing writes to it yet — it's scaffolding for
the future device_id registration feature (the proof-of-ownership
signature handshake discussed earlier), so that when that feature
actually gets built, the storage location and permissions are already
solved and don't need another round of volume configuration.
