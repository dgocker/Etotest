# Secure Relay - Change Log & Audit

## Hypothesis: Bright Light / High Complexity Lag
**Observation:** User reported that bright light on the face causes significant lag.
**Technical Analysis:** Bright light increases image complexity and sensor noise. In H.264 encoding, higher complexity results in larger frame sizes (especially for I-frames). If these frames exceed the network's instantaneous capacity, they fill up buffers, causing RTT spikes (seen in logs as 6-7s) and subsequent "Skipping frame" events.
**Status:** Attempting to mitigate via frame size limiting and dynamic resolution/FPS scaling.

---

## Attempts & Results

### Attempt 1: Orientation Fix & Basic GCC Tuning
- **Changes:**
    - Removed hardcoded iPhone/Android rotation logic.
    - Added manual Rotate/Mirror buttons to UI.
    - Lowered `minBitrate` to 100kbps.
    - Increased RTT clamp to 5000ms.
    - Reduced pacer burst multiplier to 1.2.
- **Result:** **FAILED** to resolve lag. RTT spikes persist. Orientation is now manually adjustable but still defaults incorrectly for some.

### Attempt 4: Panic Catch-up & Baseline Profile
- **Hypothesis:** High-complexity frames (bright light) arrive in bursts after network delays. The decoder's jitter buffer was skipping these late frames, causing a "freeze" loop.
- **Changes:**
    - **Panic Catch-up:** If the delay is extreme (> 2s), the decoder now plays frames immediately instead of skipping them. This prevents the freeze and allows the video to "fast-forward" back to real-time.
    - **Baseline Profile:** Switched both encoder and decoder to `avc1.42e01f` (Baseline Profile). This is less CPU-intensive and faster to decode than Main Profile, especially on mobile devices during complexity spikes.
    - **Stricter Frame Limiter:** Reduced the hard frame size limit to 100KB to prevent even smaller bursts from causing buffer bloat.
- **Result:** **FAILED.** RTT spikes and frame skipping still occur.

### Attempt 5: Token Bucket & Watchdog
- **Hypothesis:** Frame skipping was too aggressive due to incorrect token bucket logic, and the encoder was getting stuck in a "pending" state without a way to reset.
- **Changes:**
    - **Fixed Token Bucket:** Implemented proper token consumption based on estimated frame size.
    - **Encoder Watchdog:** Added a 2s timeout to reset `pendingFrames` if the encoder gets stuck.
    - **Increased Tolerance:** Raised `pendingFrames` limit to 6 and `encodeQueueSize` to 4.
    - **Dynamic Buffer:** `maxWsBuffer` is now scaled based on the current `targetBitrate`.
    - **Enhanced Logging:** Added detailed reasons for frame skipping (`WS_BUF`, `Q_PANIC`, `NO_TOKENS`).
- **Result:** **PENDING TEST.**

### Attempt 6: Asymmetric Recovery
- **Hypothesis:** Bitrate recovery was too slow after a network slowdown, causing prolonged low-quality video.
- **Changes:**
    - **Asymmetric RTT Smoothing:** Faster reaction (50% weight) when RTT drops, allowing quicker recovery detection.
    - **Multiplicative Recovery:** Bitrate now grows by a percentage + fixed amount in `recovery` state.
    - **Faster Steady Growth:** Increased bitrate growth rate when RTT is low (<150ms).
    - **Frequent Probing:** Reduced probing interval from 12s to 8s to test capacity more often.
- **Result:** **PENDING TEST.**

### Attempt 7: Precise Token Tracking & Soft Panic
- **Hypothesis:** 5-6 second recovery time is caused by "phantom" token debt and total bucket zeroing during congestion panics.
- **Changes:**
    - **Precise Token Consumption:** Switched from estimated to actual encoded size subtraction in the token bucket (in the output callback). This prevents "phantom" debt and ensures the pacer accurately reflects network reality.
    - **Softened Congestion Panic:** Instead of zeroing tokens during a panic, we now keep a small reserve (20KB). This allows the next I-frame to start sending immediately instead of waiting for the bucket to refill.
    - **Aggressive Bitrate Growth:** Increased additive increase from 10kbps to 25kbps and multiplicative growth from 6% to 8% in steady state. Reduced growth interval to 400ms.
    - **Panic Bitrate Cut:** Reduced the bitrate penalty during panic from 60% to 50% to avoid "quality death spirals" in jittery networks.
- **Result:** **PENDING TEST.**

### Attempt 8: Fast Recovery & Manual Controls
- **Hypothesis:** The "5-second freeze" during complexity spikes is caused by the decoder trying to play through a massive backlog of frames. Automatic orientation sync was also causing "double-rotation" bugs.
- **Changes:**
    - **Fast Recovery (Instant Unfreeze):** If the decoder's jitter buffer exceeds 1.5s of video, it now automatically skips to the latest keyframe. This provides an instant "jump" back to real-time.
    - **Manual Video Controls:** Added Rotate (90° steps), Horizontal Mirror, and Vertical Flip buttons for the remote video.
    - **Local Mirror Toggle:** Added a toggle for the local preview mirror state.
    - **Force Keyframe Button:** Added a manual "Force Keyframe" button (amber refresh icon) to trigger an I-frame from the sender if artifacts occur.
    - **Orientation Fix:** Removed automatic orientation sync to prevent double-rotation issues between the browser and the engine.
    - **Encoder Watchdog Reset:** The watchdog now performs a full hardware reset of the `VideoEncoder` if it detects a hang (pending frames > 2s).
- **Result:** **PENDING TEST.**

### Attempt 9: Camera Change Optimization & Vertical Fix (2026-03-19)
- **Hypothesis:** Camera changes and orientation flips generate massive I-frames that clog the sender queue, causing a multi-second lag before the new stream is visible.
- **Changes:**
    - **Sender Queue Flush:** The `AdaptiveH264Engine` now immediately clears its internal `sendQueue` when a reconfiguration (resolution/camera change) occurs. This ensures the new I-frame is sent first.
    - **Token Boost:** Added a 40KB token boost upon reconfiguration to help the initial I-frame pass through the pacer without delay.
    - **Increased Buffer Thresholds:** Raised `maxWsBuffer` to 500KB and `isInternalQueuePanic` to 60 frames to allow for larger I-frame bursts without triggering a full congestion panic.
    - **Aggressive Receiver Recovery:** Reduced the "Fast Recovery" threshold in `H264Decoder` from 1500ms to 1000ms.
    - **Always Vertical Fix:** Implemented logic in the decoder to automatically rotate landscape frames (from mobile cameras) to portrait if no manual rotation is set, ensuring the video stays vertical as requested.
- **Result:** **SUCCESS.** User reports fast recovery and vertical video orientation.

### Attempt 10: Jitter Buffer Smoothing & WebSocket Buffer Explanation (2026-03-19)
- **Hypothesis:** Sudden jumps in `targetDelay` during RTT spikes cause the video to freeze while the buffer "catches up" to the new delay, leading to perceived "pro-lags".
- **Changes:**
    - **Smooth Target Delay:** Changed the `targetDelay` adjustment in `H264Decoder` from a hard jump to a weighted average (`0.9 * old + 0.1 * new`). This makes the jitter buffer adapt gradually to network changes, reducing micro-stutters.
    - **WebSocket Buffer Logic:** Increased the `maxWsBuffer` threshold in `AdaptiveH264Engine` to 500KB. This is a software limit that controls when the engine starts dropping frames based on `ws.bufferedAmount`. Raising it allows large I-frames to pass through without triggering immediate frame skipping.
- **Result:** **PENDING TEST.**

### Attempt 11: Minimum Buffer Threshold for Playback Restart (2026-03-19)
- **Hypothesis:** Rapid stop/start cycles ("hard lag") occur because playback restarts immediately when the buffer has only 1 frame. If the network is still unstable, this frame is consumed instantly, causing another stop.
- **Changes:**
    - **Increased Restart Threshold:** Changed the playback restart condition in `H264Decoder.ts` from `jitterBuffer.length >= 1` to `jitterBuffer.length >= 5`. This ensures a small buffer (approx 166ms at 30fps) is built up before playback resumes, making it more resilient to network jitters.
- **Result:** **PENDING TEST.**

### Attempt 12: Softened Congestion Control (2026-03-19)
- **Hypothesis:** The congestion control (GCC) was too sensitive to sudden scene changes (like turning on the light), causing aggressive bitrate cuts and "quality death spirals" that persisted until the scene stabilized.
- **Changes:**
    - **Relaxed Overuse Thresholds:** Increased the `delayTrend` threshold by 50%, `queueDelay` limit to 250ms, and `buffered` limit to 250KB in `AdaptiveH264Engine.ts`.
    - **Softer Bitrate Cuts:** Reduced the bitrate reduction factor during congestion to be less aggressive (0.7-0.9 instead of 0.6-0.83). This prevents the encoder from overreacting to transient bursts.
- **Result:** **PENDING TEST.**

### Attempt 13: Extreme RTT Spike Protection (2026-03-19)
- **Hypothesis:** When RTT spikes to extreme levels (>3000ms) due to scene changes, the `sendQueue` becomes clogged with stale frames that the network can no longer deliver in time. This creates a "zombie" state where the engine tries to send old data instead of new, fresh frames.
- **Changes:**
    - **Forced Queue Flush:** Added logic in `AdaptiveH264Engine.ts` to immediately clear the `sendQueue` when an extreme RTT spike (>3000ms) is detected. This forces the engine to drop the backlog and start sending fresh frames immediately, breaking the congestion loop.
- **Result:** **PENDING TEST.**

### Attempt 14: Honest FPS Reporting (2026-03-19)
- **Hypothesis:** The UI was reporting the *target* FPS, which was misleading when the encoder was struggling to keep up with the complexity of the scene (e.g., when the light was turned on). This made the video appear to lag even when the FPS counter was high.
- **Changes:**
    - **Actual FPS Estimation:** Updated `getStats()` in `AdaptiveH264Engine.ts` to report an estimated *actual* FPS based on the average encoding duration (`avgEncode`). This provides a more realistic view of the performance.
- **Result:** **PENDING TEST.**

### Attempt 15: Conservative Initial Probe (2026-03-19)
- **Hypothesis:** The initial bitrate (1Mbps) and token burst (62.5KB) were too aggressive for the network to handle immediately upon connection, causing an instant congestion event that the engine struggled to recover from.
- **Changes:**
    - **Reduced Initial Bitrate:** Lowered the initial `targetBitrate` to 600Kbps.
    - **Reduced Initial Token Burst:** Lowered the initial `tokenBucketBytes` to 18.75KB. This ensures a smoother start to the stream.
- **Result:** **PENDING TEST.**

### Attempt 16: Stability-First Configuration (2026-03-19)
- **Hypothesis:** The previous bitrate settings (min 350Kbps, max 6Mbps) were still too high for the network, leading to constant buffer underruns and playback restarts.
- **Changes:**
    - **Lowered Bitrate Limits:** Reduced `minBitrate` to 200Kbps and `maxBitrate` to 4Mbps.
    - **Conservative Start:** Lowered initial `targetBitrate` to 500Kbps and reduced the token burst size even further. This forces the engine to start at a lower quality level and only scale up if the network proves stable.
- **Result:** **PENDING TEST.**

### Attempt 17: Eliminating Self-Induced Congestion (2026-03-19)
- **Hypothesis:** The "probing" mechanism (which was tripling the bitrate every 8 seconds) was causing self-induced congestion. Even on a stable network, the system would force a massive spike, trigger the overuse detector, and then cut the bitrate, creating a permanent oscillation.
- **Changes:**
    - **Disabled Probing:** Completely disabled the aggressive 3.5x bitrate probing mechanism.
    - **Relaxed Overuse Thresholds:** Increased the thresholds for triggering congestion (`queueDelay` to 400ms, `buffered` to 400KB), allowing the system more breathing room before overreacting.
- **Result:** **PENDING TEST.**

### Attempt 18: Aggressive Recovery (2026-03-19)
- **Hypothesis:** After a congestion event (like turning on the light), the system was recovering too slowly, keeping the bitrate low even after the network stabilized.
- **Changes:**
    - **Faster Bitrate Recovery:** Increased the `recoveryFactor` (from 1.08/1.04 to 1.15/1.08) and doubled the additive boost (from 50K to 100K) in `AdaptiveH264Engine.ts`. This allows the engine to jump back to high quality much faster once the network clears.
- **Result:** **PENDING TEST.**

### Attempt 19: High-Efficiency Encoding (2026-03-19)
- **Hypothesis:** The encoder was using the Baseline Profile (`avc1.42e01f`), which is compatible but less efficient at low bitrates (1Mbps). Switching to High Profile (`avc1.64001f`) should provide better visual quality for the same amount of data.
- **Changes:**
    - **Codec Profile Upgrade:** Switched the H.264 encoder profile from Baseline to High in `AdaptiveH264Engine.ts`.
- **Result:** **PENDING TEST.**

### Attempt 20: Decoupling Encoder Pipeline (2026-03-19)
- **Hypothesis:** The `VideoEncoder.output` callback was `async` and `await`ing encryption/obfuscation, which blocked the encoder from processing the next frame. This was the fundamental cause of the lag during complex scenes (like turning on the light).
- **Changes:**
    - **Async Frame Processing:** Decoupled encryption and obfuscation from the `VideoEncoder.output` callback. The callback now immediately returns after pushing the frame to an asynchronous processor, allowing the encoder to run at full speed without waiting for network/crypto tasks.
- **Result:** **PENDING TEST.**

### Attempt 21: Aggressive Pacing (2026-03-19)
- **Hypothesis:** Even with the encoder unblocked, the "Pacer" (the component that actually sends data over the WebSocket) was too restrictive, artificially holding back frames in the queue and causing a backlog that felt like lag.
- **Changes:**
    - **Increased Pacer Burst:** Doubled the maximum allowed burst size (`maxPacerBurst`) and increased the burst multiplier (`multiplier`) when the queue is large. This allows the system to "dump" accumulated frames into the network much faster when the network is available.
- **Result:** **PENDING TEST.**

### Attempt 22: Reducing Decoder Latency (2026-03-19)
- **Hypothesis:** The decoder was intentionally holding back frames for 2 seconds (`targetDelay`) to handle RTT spikes, which was the primary cause of the high perceived latency ("pro-lag").
- **Changes:**
    - **Reduced Target Delay:** Lowered the initial `targetDelay` from 2000ms to 500ms in `H264Decoder.ts`.
    - **Adaptive Jitter Buffer Limits:** Reduced `MAX_DELAY` (to 2s) and `MIN_DELAY` (to 50ms) to make the jitter buffer much more responsive to network changes.
- **Result:** **PENDING TEST.**

---

## Current Observations (2026-03-19)
- **Camera Reaction:** Significantly improved. Clearing the queue on reconfiguration prevents "zombie frames" from the old camera state from delaying the new stream.
- **Orientation:** "Always Vertical" mode is active. Landscape frames are auto-rotated to portrait.
- **Frame Skipping:** Still present in logs during high-complexity scenes, but recovery is now near-instant (<1s) due to the aggressive jitter buffer catch-up.
