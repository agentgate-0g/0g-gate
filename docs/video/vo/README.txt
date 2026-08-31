Voice-over text for agentgate-demo-1080p.mp4 (165.0s, 30 fps, no audio track).

One file per scene, plain text, nothing to strip. Paste a file into ElevenLabs,
generate, download. Generate each scene separately — every scene starts on an
exact second, so per-scene audio drops onto the timeline with no drift.

  scene  file                 starts at   runs for
    1    1-what-it-is          0:00        18s
    2    2-zero-setup          0:18        22s
    3    3-real-402            0:40        25s
    4    4-full-loop           1:05        35s
    5    5-receipts            1:40        30s
    6    6-any-agent           2:10        22s
    7    7-live-today          2:32        13s

all-scenes.txt is the same text in one block, if you would rather generate once
and cut it yourself.

Technical terms are spelled the way they should be SPOKEN, not the way they are
written on screen: "zero-G" for 0G, "four-oh-two" for 402, "x-four-oh-two" for
x402, "Payment Router" for PaymentRouter, "N-P-X agentgate zero-G list" for the
npx command. Do not "fix" these back — a TTS engine reads 402 as "four hundred
two" and 0G as "oh gee".

Every scene is paced at 112-147 words per minute, so no line needs rushing.
Scene timings and on-screen cues: ../../VIDEO_VO_SCRIPT.md

Merge when done:
  ffmpeg -i agentgate-demo-1080p.mp4 -i vo.wav -c:v copy -c:a aac -b:a 192k -shortest out.mp4
