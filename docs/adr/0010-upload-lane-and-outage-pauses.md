# Run uploads in their own lane and pause lanes during outages

Track Steps run in two lanes. The acquire lane (match, lyrics, download, retag, move) takes one track at a time. The upload lane runs up to three uploads at once, so a slow link to the Remote Library no longer holds up downloads. A track is in one lane and one step at a time, so an upload never races the same track's retag, move or delete.

An upload sends the audio and its lyrics sidecar in one rclone run and verifies both with one hashed listing before recording them (ADR 0005). The Remote Library listing from the last audit lets a new upload skip asking whether the remote already has the file.

The audit of the Remote Library runs at startup, when the remote changes, and as the probe after a lost connection, not on every like check. Likes never wait on the VPS.

A lost connection is not a failed Track Step. Connectivity errors (DNS, refused or timed-out connections, no route) pause only the lane they hit, the upload lane for the VPS and the acquire lane for the internet, without using any track's retries. The lane probes again after 1, 2 and 5 minutes, then every 10 minutes, and Activity says "Can't reach the VPS" or "Offline" meanwhile. Every other failure keeps the per-track backoff and Needs Attention behavior.

Child processes get an idle timeout (no output for five minutes), and an abort or timeout escalates from SIGTERM to SIGKILL, so a hung tool cannot stall a lane or block quitting.
