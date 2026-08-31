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

---

MUXING THE GENERATED AUDIO — two things bite.

1. ElevenLabs output is very quiet. The file generated here measured -52.1 LUFS
   integrated, peaking at -32.2 dBFS. Muxed as-is it is nearly inaudible next to
   any other video. Normalise before muxing.

2. It will not match 165.0s. One generation from all-scenes.txt came out 174.05s,
   9 seconds long. `-shortest` would cut the closing line off. Fit it with atempo
   instead: the script is budgeted per scene, so a uniform tempo change keeps each
   paragraph inside its own scene (measured drift: 1.0s worst case, most under 0.3s).

The pipeline that produced agentgate-demo-final-1080p.mp4:

  # 1. measure
  ffmpeg -i vo.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -

  # 2. normalise with the measured values from step 1
  ffmpeg -i vo.mp3 -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=...:measured_TP=...\
:measured_LRA=...:measured_thresh=...:offset=...:linear=true,aresample=48000" \
    -ar 48000 -ac 1 vo_norm.wav

  # 3. fit to the video length: atempo = audio_duration / 165.0
  ffmpeg -i vo_norm.wav -af "atempo=1.054872,aresample=48000" -ar 48000 -ac 1 vo_fit.wav

  # 4. mux — video copied, never re-encoded
  ffmpeg -i agentgate-demo-1080p.mp4 -i vo_fit.wav -map 0:v -map 1:a \
    -c:v copy -c:a aac -b:a 192k -movflags +faststart agentgate-demo-final-1080p.mp4

Result: -16.05 LUFS integrated, -1.43 dBTP, speech present in all seven scene
windows, video stream MD5-identical to the silent master.
