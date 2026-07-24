# .onion Hidden Service Setup

This relay can now run as a Tor hidden service, in addition to (or
instead of) its existing clearnet Railway URL. Once running, clients
connect via `ws://<your-address>.onion:8080` instead of
`wss://...railway.app` — no TLS needed, since Tor's own protocol
already provides authenticated end-to-end encryption to the hidden
service.

## What changed

- **`torrc`** — Tor daemon config: defines the hidden service, and
  enables both of Tor's native DoS defenses (introduction-point rate
  limiting + proof-of-work for rendezvous requests). No code in
  `src/` was touched — the relay still just listens on
  `127.0.0.1:8080`, completely unaware Tor exists.
- **`docker-entrypoint.sh`** — starts both Tor and the Node relay in
  one container, and exits (triggering a restart) if either process
  dies.
- **`Dockerfile`** — installs Tor, sets up the hidden service
  directory with correct permissions, uses the new entrypoint.

## ⚠️ Back up the hidden service key before your first real deploy

The `.onion` address is derived from a private key Tor generates the
first time it starts, stored at
`/var/lib/tor/d-chat-relay/hs_ed25519_secret_key` inside the
container. **This does not persist across redeploys unless you
explicitly persist it** — Railway containers are ephemeral by
default. Losing this key means your `.onion` address changes, which
breaks every copy of the app that has the old address hardcoded — the
exact same class of problem as losing your APK signing key.

**To persist it on Railway:** add a Railway Volume mounted at
`/var/lib/tor/d-chat-relay`, so the key survives redeploys.

**To back it up yourself:** after first deploy, copy the key out and
store it somewhere durable (encrypted), the same way `RELEASING.md`
describes for the APK signing key:

```bash
# Via Railway CLI, or docker cp if running locally
railway run cat /var/lib/tor/d-chat-relay/hs_ed25519_secret_key > onion-key-backup
gpg -c onion-key-backup   # encrypt before storing anywhere off this machine
```

To restore it later (new deploy, disaster recovery), place the
decrypted key file back at that same path before Tor starts — it will
reuse it instead of generating a new one, and the `.onion` address
will be identical to before.

## Getting your `.onion` address after deploying

```bash
# Local Docker
docker exec -it <container> cat /var/lib/tor/d-chat-relay/hostname

# Railway
railway run cat /var/lib/tor/d-chat-relay/hostname
```

Update `RELAY_WS_URL` in the app's `src/constants/config.js` to
`ws://<that address>:8080` once you have it.

---

# Question 1 — Copying These Changes Into Your Project Folder (Mac)

You'll get a `.zip` from me containing only the new/changed files.
On Mac:

```bash
# 1. Move the zip into (or near) your project folder, then:
cd ~/Downloads   # or wherever the zip landed
unzip relay-onion-update.zip -d relay-onion-update

# 2. Copy each file into your actual project, preserving structure.
#    Adjust the destination path to wherever your repo actually lives.
cd relay-onion-update/d-chat-relay-server

cp torrc                 ~/path/to/d-chat-relay-server/torrc
cp docker-entrypoint.sh  ~/path/to/d-chat-relay-server/docker-entrypoint.sh
cp Dockerfile            ~/path/to/d-chat-relay-server/Dockerfile

# 3. Make the entrypoint script executable — this bit doesn't survive
#    a zip download/extract on its own, must be set again manually:
chmod +x ~/path/to/d-chat-relay-server/docker-entrypoint.sh

# 4. Confirm git sees the changes
cd ~/path/to/d-chat-relay-server
git status
```

---

# Question 2 — Testing the Relay Locally on Your Mac

You have two options — Docker (matches production exactly) or running
Tor + Node directly (faster iteration, no image rebuilds).

## Option A — Docker (recommended, matches production exactly)

Install Docker Desktop for Mac if you don't have it:
```bash
brew install --cask docker
```
Open Docker Desktop once from Applications so its background engine
starts, then:

```bash
cd ~/path/to/d-chat-relay-server
docker build -t d-chat-relay .
docker run -p 8080:8080 d-chat-relay
```

Watch the logs for the onion address:
```
[entrypoint] Onion address: xxxxxxxxxxxxxxxxxxxx.onion
```

In another terminal tab, grab it directly:
```bash
docker ps                          # find the container ID/name
docker exec -it <container> cat /var/lib/tor/d-chat-relay/hostname
```

## Option B — Run Tor and Node directly (faster for iterating)

```bash
# Install Tor via Homebrew
brew install tor

# Run Tor with our config (edit the HiddenServiceDir path in torrc
# first — the container's /var/lib/tor path assumes Linux root
# permissions; locally, point it somewhere in your home directory)
mkdir -p ~/d-chat-tor-data
sed 's|/var/lib/tor/d-chat-relay/|'"$HOME"'/d-chat-tor-data/|' torrc > /tmp/torrc.local
tor -f /tmp/torrc.local &

# In another terminal, run the relay itself as normal
cd ~/path/to/d-chat-relay-server
npm install
node src/server.js
```

Get your local `.onion` address:
```bash
cat ~/d-chat-tor-data/hostname
```

## Verifying it actually works, from your Mac

Install a Tor-aware client to test the connection:
```bash
brew install tor
brew services start tor   # runs a local SOCKS5 proxy on 127.0.0.1:9050

# Test with curl through it (install torsocks for convenience)
brew install torsocks
torsocks curl http://<your-address>.onion:8080/health
```
You should get back the same JSON health response the relay always
returns (`{"status":"ok", ...}`) — confirming the whole path (Tor →
hidden service → Node relay) works end to end.

---

# Question 3 — Testing the Mobile App on Your Mac

This means running the Android app in an emulator on your Mac,
pointed at the `.onion` relay from Question 2.

## Setup

```bash
brew install --cask android-studio
```
Open Android Studio once, then **Tools → Device Manager → Create
Device**, pick a Pixel profile, choose a system image, and let it
download. Start the emulator from Device Manager, or:
```bash
emulator -list-avds
emulator -avd <your_avd_name>
```

## The good news: no network tricks needed for the relay connection

This is worth being explicit about, because it's genuinely simpler
than typical local-network testing between an emulator and your host
machine. Normally, testing an app against something running on your
Mac requires special addressing (like `10.0.2.2`, the emulator's alias
for "the host machine"), because the emulator and your Mac are on
different local networks.

**`.onion` addresses don't have this problem.** Once your Mac's Tor
daemon has bootstrapped and published the hidden service's descriptor
to the real, global Tor network, it's reachable by name from *any*
Tor client anywhere — including the embedded Tor daemon running
inside the app on your emulator — exactly the same way it would be
reachable from a real phone on the other side of the world. Your Mac
just needs a working internet connection so its Tor daemon can stay
connected to the Tor network; no port forwarding, no special emulator
networking flags.

## Running the app

```bash
cd ~/path/to/dchat   # your React Native app's project folder
npx expo run:android
```

This installs the dev build onto whichever emulator is currently
running. Update `RELAY_WS_URL` in `src/constants/config.js` to your
new `.onion` address first, matching what Question 2 gave you.

## A note on emulator vs. real device for this specific test

The app's embedded Tor daemon (`TorModule.java`) is native code — it
runs correctly inside an Android emulator, since emulators execute a
real Android OS image, not just a UI mockup. For a first functional
test of "does the `.onion` connection work at all," the emulator is
fine and faster to iterate on than deploying to a phone repeatedly.

That said — given everything encountered earlier in this project
around Android's background process handling (the screen-off /
Doze-mode delivery bug from earlier), **do a final verification pass
on a real physical device** before considering this done. Emulators
don't always replicate real-device power management behavior
faithfully, and that's exactly the category of bug that's shown up
before in this exact codebase.
