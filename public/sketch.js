// This is an example written by Carrie Wang for the course: Chatbots for Art's Sake.

// It uses the Replicate proxy for chat responses.

// It uses p5.js for the chat interface.
// Language model: openai/gpt-5-mini, configured on the server.
// With session memory added.

const MAX_CONTEXT_MESSAGES = 14;

let systemPrompt; //variable for loading the prompt
let conversationHistory = []; //we'll start a variable where we save all conversation history to, so everytime we make an API call, the session memory persists

let myButton, myInput, myOutput, myVideo;
let micButton, voiceToggleButton;
let webcamCanvas;
let faceapi;
let detections = [];
let faceModelReady = false;
let scanOffset = 0;
let webcamReady = false;
let webcamErrorMessage = "";
const CAPTURE_W = 640;
const CAPTURE_H = 480;
const VIDEO_FIT_MODE = "cover"; // "cover" fills canvas, "contain" shows full frame.
let mediaRecorder = null;
let mediaStream = null;
let micChunks = [];
let isRecording = false;
let isTranscribing = false;
let aiVoiceEnabled = true;
let activeAudio = null;
let activeAudioUrl = "";
let audioContext = null;
let analyserNode = null;
let micLevelData = null;
let micLevel = 0;
let micStatus = null;
let micMeterFill = null;
let recordingStartedAt = 0;
let voicedDurationMs = 0;
let peakMicLevel = 0;
let browserSpeechRecognition = null;
let browserSpeechActive = false;
let browserSpeechFinalText = "";
let browserSpeechInterimText = "";
let browserSpeechStopResolver = null;
const MIC_SPEECH_LEVEL_THRESHOLD = 0.055;
const MIC_MIN_VOICED_MS = 260;
const MIC_MIN_RECORDING_MS = 450;
const FAST_TRANSCRIPT_MIN_CHARS = 8;
const FAST_TRANSCRIPT_STOP_WAIT_MS = 550;
const EMOTION_KEYS = ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"];
const EMOTION_SMOOTHING = 0.22;
const EMOTION_STALE_MS = 2200;
const EMOTION_HISTORY_MAX = 120;
const REACTION_WINDOW_MS = 7000;
const MIN_EMOTION_REPORT_CONFIDENCE = 0.45;
const MIN_EXPRESSION_CALLOUT_CONFIDENCE = 0.34;
const EMOTION_AFFECT_MAP = {
  neutral: "focused",
  happy: "amused",
  sad: "low-energy",
  angry: "frustrated",
  fearful: "hesitant",
  disgusted: "skeptical",
  surprised: "alert",
};

let emotionEMA = {};
let emotionTimeline = [];
let lastEmotionSnapshot = null;
let lastFaceSeenAt = 0;
let pendingReactionWindow = null;
let lastReactionSummary = null;
let reactionSummaryCounter = 0;
let lastReactionSummaryUsed = 0;

// GitHub Pages uses the existing public course proxy and browser voice.
// Server deployments can also offer private-key voice services.
const IS_GITHUB_PAGES = document.querySelector('meta[name="fulana-hosting"]')?.content === "github-pages";
let voiceAvailable = false;
if (!IS_GITHUB_PAGES) fetch("/api/config").then(r => r.json()).then(config => {
  voiceAvailable = config.voiceAvailable === true;
}).catch(() => {});

function hasServerVoice() { return voiceAvailable; }

function preload() {
  systemPrompt = loadStrings("bot.txt"); //load the prompt into the variable, loadStrings will make an array of text strings
}

function setup() {
  noCanvas();
  initializeEmotionTracking();

  //the first message in the conversation history is a System Prompt for the chatbot
  conversationHistory = [
    {
      role: "system",
      content: systemPrompt.join(" ") //change the prompt from an array to a string using join
    },
  ];

  myInput = createInput("");
  myInput.parent("chat-input-mount");
  myInput.addClass("chat-input-field");
  myInput.attribute("placeholder", "Type your message...");
  myInput.elt.setAttribute("aria-label", "Chat message");

  myButton = createButton("Send");
  myButton.parent("chat-button-mount");
  myButton.addClass("chat-send-button");
  myButton.mousePressed(chat); //go to the chat function when the button is pressed
  setupVoiceControls();

  myOutput = select("#chat-output");
  appendMessage("bot", "Hi founder. I’m Fulana. I can see team flow across Slack, meetings, and cameras. What should we fix first?");

  setupWebcam();
  window.addEventListener("resize", resizeEmotionCanvas);
}

function setupVoiceControls() {
  micButton = createButton("Mic");
  micButton.parent("chat-button-mount");
  micButton.addClass("chat-mic-button");
  micButton.mousePressed(toggleMicInput);

  voiceToggleButton = createButton("Voice On");
  voiceToggleButton.parent("chat-button-mount");
  voiceToggleButton.addClass("chat-voice-button");
  voiceToggleButton.mousePressed(toggleVoiceOutput);

  micStatus = createElement("div", "Mic ready");
  micStatus.parent("chat-button-mount");
  micStatus.addClass("chat-mic-status");

  const meter = createElement("div");
  meter.parent("chat-button-mount");
  meter.addClass("chat-mic-meter");
  micMeterFill = createElement("div");
  micMeterFill.parent(meter);
  micMeterFill.addClass("chat-mic-meter-fill");

  updateMicButtonState("ready");
  updateVoiceButtonState();
}

async function toggleMicInput() {
  if (isTranscribing) {
    return;
  }

  if (isRecording) {
    stopRecording();
    return;
  }

  if (!hasServerVoice() && !browserSpeechSupported()) {
    updateMicButtonState("missing-key");
    return;
  }

  const stream = await requestMicrophoneStream();
  if (!stream) {
    updateMicButtonState("blocked");
    return;
  }

  startRecording(stream);
}

function startRecording(stream) {
  mediaStream = stream;
  micChunks = [];
  recordingStartedAt = millis();
  voicedDurationMs = 0;
  peakMicLevel = 0;
  resetBrowserSpeechBuffers();
  initializeMicMeter(stream);

  let recorderOptions = {};
  if (window.MediaRecorder && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
    recorderOptions = { mimeType: "audio/webm;codecs=opus" };
  }

  try {
    mediaRecorder = new MediaRecorder(mediaStream, recorderOptions);
  } catch (error) {
    console.log("MediaRecorder init error:", error);
    cleanupMicStream();
    updateMicButtonState("blocked");
    return;
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      micChunks.push(event.data);
    }
  };

  mediaRecorder.onerror = (event) => {
    console.log("MediaRecorder error:", event.error || event);
    isRecording = false;
    isTranscribing = false;
    cleanupMicStream();
    updateMicButtonState("blocked");
  };

  mediaRecorder.onstop = async () => {
    isRecording = false;
    isTranscribing = true;
    updateMicButtonState("transcribing");

    const mimeType = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
    const audioBlob = new Blob(micChunks, { type: mimeType });
    cleanupMicStream();

    try {
      const fastTranscript = await stopBrowserSpeechRecognition();
      const recordingDurationMs = millis() - recordingStartedAt;
      const hasSpeechEnergy =
        recordingDurationMs >= MIC_MIN_RECORDING_MS &&
        voicedDurationMs >= MIC_MIN_VOICED_MS &&
        peakMicLevel >= MIC_SPEECH_LEVEL_THRESHOLD;

      if (!hasSpeechEnergy) {
        updateMicButtonState("empty");
      } else if (fastTranscript && fastTranscript.length >= FAST_TRANSCRIPT_MIN_CHARS) {
        updateMicButtonState("sending");
        myInput.value(fastTranscript);
        chat(fastTranscript);
        myInput.value("");
      } else {
        if (!hasServerVoice()) {
          updateMicButtonState("empty");
        } else {
          const transcript = await transcribeAudioWithElevenLabs(audioBlob);
          if (transcript) {
            updateMicButtonState("sending");
            myInput.value(transcript);
            chat(transcript);
            myInput.value("");
          } else {
            updateMicButtonState("empty");
          }
        }
      }
    } catch (error) {
      console.log("Transcription error:", error);
      updateMicButtonState("error");
    } finally {
      isTranscribing = false;
      if (!isRecording) {
        updateMicButtonState("ready");
      }
    }
  };

  stopCurrentVoicePlayback();
  startBrowserSpeechRecognition();
  mediaRecorder.start(250);
  isRecording = true;
  updateMicButtonState("recording");
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  } else {
    isRecording = false;
    updateMicButtonState("ready");
  }
}

function cleanupMicStream() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  micLevel = 0;
  updateMicMeterUI(0);
  teardownMicMeter();
}

async function requestMicrophoneStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return null;
  }

  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    console.log("Microphone permission error:", error);
    return null;
  }
}

function sanitizeTranscriptText(text) {
  if (!text || typeof text !== "string") {
    return "";
  }

  return text
    .replace(/\[(?:laugh|laughter|chuckle|chuckles|sigh|breath|sniff|click|cough|background[^\]]*)\]/gi, " ")
    .replace(/\((?:laugh|laughter|chuckle|chuckles|sigh|breath|sniff|click|cough|background[^\)]*)\)/gi, " ")
    .replace(/\*(?:laugh|laughter|chuckle|chuckles|sigh|breath|sniff|click|cough|background[^*]*)\*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function browserSpeechSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function resetBrowserSpeechBuffers() {
  browserSpeechFinalText = "";
  browserSpeechInterimText = "";
}

function getBrowserSpeechText() {
  return sanitizeTranscriptText(`${browserSpeechFinalText} ${browserSpeechInterimText}`.trim());
}

function startBrowserSpeechRecognition() {
  if (!browserSpeechSupported()) {
    return;
  }

  const SpeechCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  resetBrowserSpeechBuffers();
  browserSpeechRecognition = new SpeechCtor();
  browserSpeechRecognition.lang = "en-US";
  browserSpeechRecognition.continuous = true;
  browserSpeechRecognition.interimResults = true;
  browserSpeechRecognition.maxAlternatives = 1;

  browserSpeechRecognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result && result[0] && result[0].transcript ? result[0].transcript : "";
      if (!text) {
        continue;
      }
      if (result.isFinal) {
        browserSpeechFinalText += `${text} `;
      } else {
        interim += text;
      }
    }
    browserSpeechInterimText = interim;

    const preview = getBrowserSpeechText();
    if (isRecording && preview && myInput) {
      myInput.value(preview);
    }
  };

  browserSpeechRecognition.onerror = (event) => {
    console.log("Browser speech error:", event.error || event);
  };

  browserSpeechRecognition.onend = () => {
    browserSpeechActive = false;
    if (browserSpeechStopResolver) {
      const resolve = browserSpeechStopResolver;
      browserSpeechStopResolver = null;
      resolve(getBrowserSpeechText());
    }
  };

  try {
    browserSpeechRecognition.start();
    browserSpeechActive = true;
  } catch (error) {
    browserSpeechActive = false;
    console.log("Browser speech start error:", error);
  }
}

function stopBrowserSpeechRecognition(waitMs = FAST_TRANSCRIPT_STOP_WAIT_MS) {
  const immediate = getBrowserSpeechText();
  if (!browserSpeechRecognition || !browserSpeechActive) {
    return Promise.resolve(immediate);
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (textValue = "") => {
      if (done) {
        return;
      }
      done = true;
      resolve(sanitizeTranscriptText(textValue || getBrowserSpeechText()));
    };

    browserSpeechStopResolver = (textValue) => {
      finish(textValue);
    };

    setTimeout(() => {
      if (browserSpeechStopResolver) {
        browserSpeechStopResolver = null;
      }
      finish(getBrowserSpeechText());
    }, waitMs);

    try {
      browserSpeechRecognition.stop();
    } catch (error) {
      console.log("Browser speech stop error:", error);
      finish(getBrowserSpeechText());
    }
  });
}

function transcriptFromWordsOnly(data) {
  if (!data || !Array.isArray(data.words) || data.words.length === 0) {
    return "";
  }

  const parts = [];
  for (let i = 0; i < data.words.length; i++) {
    const token = data.words[i] || {};
    const tokenType = String(token.type || token.token_type || "word").toLowerCase();

    if (tokenType.includes("audio") || tokenType.includes("event") || tokenType.includes("noise")) {
      continue;
    }

    const value =
      typeof token.text === "string"
        ? token.text
        : typeof token.word === "string"
          ? token.word
          : "";

    if (!value) {
      continue;
    }

    if (tokenType === "spacing") {
      parts.push(value);
      continue;
    }

    if (parts.length > 0 && !String(parts[parts.length - 1]).endsWith(" ") && !/^[,.;:!?)]/.test(value)) {
      parts.push(" ");
    }

    parts.push(value);
  }

  return sanitizeTranscriptText(parts.join(""));
}

async function transcribeAudioWithElevenLabs(audioBlob) {
  if (!audioBlob || audioBlob.size < 1200) {
    return "";
  }

  if (!hasServerVoice()) throw new Error("Server voice is unavailable.");
  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": audioBlob.type || "audio/webm" },
    body: audioBlob,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs STT HTTP ${response.status}: ${errText.slice(0, 180)}`);
  }

  const data = await response.json();
  const wordsText = transcriptFromWordsOnly(data);
  if (wordsText) {
    return wordsText;
  }

  const plainText = sanitizeTranscriptText(data.text || data.transcript || "");
  return plainText.trim();
}

function updateMicButtonState(state = "") {
  if (!micButton) {
    return;
  }

  if (state === "sending") {
    micButton.html("Sending");
    micButton.removeClass("is-listening");
    setMicStatusText("Sending your message...");
    return;
  }

  if (state === "transcribing") {
    micButton.html("Transcribing");
    micButton.removeClass("is-listening");
    setMicStatusText("Turning speech into text...");
    return;
  }

  if (state === "recording" || isRecording) {
    micButton.html("Stop");
    micButton.addClass("is-listening");
    setMicStatusText("Recording... speak then press Stop");
    return;
  }

  if (isTranscribing) {
    micButton.html("Transcribing");
    micButton.removeClass("is-listening");
    setMicStatusText("Turning speech into text...");
    return;
  }

  if (state === "blocked") {
    micButton.html("Mic Blocked");
    micButton.removeClass("is-listening");
    setMicStatusText("Microphone permission blocked or unavailable.");
    return;
  }

  if (state === "error") {
    micButton.html("Try Again");
    micButton.removeClass("is-listening");
    setMicStatusText("Transcription failed. Check ElevenLabs key and network.");
    return;
  }

  if (state === "missing-key") {
    micButton.html("Voice unavailable");
    micButton.removeClass("is-listening");
    setMicStatusText("Voice service unavailable. You can type your message.");
    return;
  }

  if (state === "empty") {
    micButton.html("No Voice");
    micButton.removeClass("is-listening");
    setMicStatusText("No clear speech detected. Ignore clicks/chuckles and speak closer.");
    setTimeout(() => {
      if (!isRecording && !isTranscribing && micButton) {
        micButton.html("Mic");
      }
    }, 800);
    return;
  }

  micButton.html("Mic");
  micButton.removeClass("is-listening");
  setMicStatusText("Mic ready");
}

function initializeMicMeter(stream) {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (audioContext.state === "suspended") {
      audioContext.resume();
    }

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyserNode);
    micLevelData = new Uint8Array(analyserNode.frequencyBinCount);
  } catch (error) {
    console.log("Mic meter init error:", error);
    analyserNode = null;
    micLevelData = null;
  }
}

function teardownMicMeter() {
  analyserNode = null;
  micLevelData = null;
}

function updateMicMeter() {
  if (!isRecording || !analyserNode || !micLevelData) {
    micLevel = 0;
    updateMicMeterUI(0);
    return;
  }

  analyserNode.getByteTimeDomainData(micLevelData);
  let sum = 0;
  for (let i = 0; i < micLevelData.length; i++) {
    const norm = (micLevelData[i] - 128) / 128;
    sum += norm * norm;
  }
  const rms = Math.sqrt(sum / micLevelData.length);
  micLevel = Math.min(1, rms * 6);

  if (micLevel > peakMicLevel) {
    peakMicLevel = micLevel;
  }
  if (micLevel >= MIC_SPEECH_LEVEL_THRESHOLD) {
    voicedDurationMs += typeof deltaTime === "number" ? deltaTime : 16;
  }

  updateMicMeterUI(micLevel);
}

function updateMicMeterUI(level) {
  if (!micMeterFill) {
    return;
  }
  const widthPercent = Math.max(3, Math.floor(level * 100));
  micMeterFill.elt.style.width = `${widthPercent}%`;
}

function setMicStatusText(message) {
  if (!micStatus) {
    return;
  }
  micStatus.html(message);
}

function toggleVoiceOutput() {
  aiVoiceEnabled = !aiVoiceEnabled;
  if (!aiVoiceEnabled) {
    stopCurrentVoicePlayback();
  }
  updateVoiceButtonState();
}

function updateVoiceButtonState() {
  if (!voiceToggleButton) {
    return;
  }

  if (aiVoiceEnabled) {
    voiceToggleButton.html("Voice On");
    voiceToggleButton.removeClass("is-muted");
  } else {
    voiceToggleButton.html("Voice Off");
    voiceToggleButton.addClass("is-muted");
  }
}

function stopCurrentVoicePlayback() {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }

  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = "";
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

async function speakResponse(text) {
  if (!aiVoiceEnabled || !text || !text.trim()) {
    return;
  }

  stopCurrentVoicePlayback();

  try {
    const audioUrl = await synthesizeElevenLabsAudio(text);
    if (!audioUrl) {
      setMicStatusText("Using default browser voice.");
      speakWithBrowserTTS(text);
      return;
    }

    activeAudioUrl = audioUrl;
    activeAudio = new Audio(audioUrl);
    activeAudio.onended = () => {
      if (activeAudioUrl) {
        URL.revokeObjectURL(activeAudioUrl);
        activeAudioUrl = "";
      }
      activeAudio = null;
    };
    await activeAudio.play();
  } catch (error) {
    console.log("Voice synthesis error:", error);
    const message = error && error.message ? error.message : "ElevenLabs voice request failed.";
    if (message.includes("quota_exceeded")) {
      setMicStatusText("ElevenLabs credits unavailable. Using default browser voice.");
    } else {
      setMicStatusText("ElevenLabs unavailable. Using default browser voice.");
    }
    speakWithBrowserTTS(text);
  }
}

async function synthesizeElevenLabsAudio(text) {
  if (!hasServerVoice()) return null;
  const response = await fetch("/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs HTTP ${response.status}: ${errText.slice(0, 180)}`);
  }

  const audioBlob = await response.blob();
  return URL.createObjectURL(audioBlob);
}

function speakWithBrowserTTS(text) {
  if (!window.speechSynthesis) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function setupWebcam() {
  const size = getWebcamMountSize();
  setWebcamPlaceholder("STARTING CAMERA", true);

  webcamCanvas = createCanvas(size.w, size.h);
  webcamCanvas.parent("webcam-mount");
  webcamCanvas.addClass("emotion-canvas");
  pixelDensity(1);

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    webcamErrorMessage = "CAMERA API NOT AVAILABLE";
    setWebcamPlaceholder(webcamErrorMessage, true);
    return;
  }

  try {
    myVideo = createCapture(
      {
        video: {
          facingMode: "user",
        },
        audio: false,
      },
      () => {
        webcamErrorMessage = "";
      }
    );
  } catch (err) {
    webcamErrorMessage = "CAMERA BLOCKED";
    setWebcamPlaceholder(webcamErrorMessage, true);
    console.log(err);
    return;
  }

  myVideo.size(CAPTURE_W, CAPTURE_H);
  myVideo.elt.setAttribute("playsinline", "");
  myVideo.elt.setAttribute("autoplay", "");
  myVideo.elt.setAttribute("muted", "");
  myVideo.elt.muted = true;
  myVideo.hide();

  myVideo.elt.onloadedmetadata = () => {
    webcamReady = true;
    webcamErrorMessage = "";
    setWebcamPlaceholder("", false);

    const playAttempt = myVideo.elt.play();
    if (playAttempt && typeof playAttempt.catch === "function") {
      playAttempt.catch(() => {
        webcamErrorMessage = "ALLOW CAMERA ACCESS";
        setWebcamPlaceholder(webcamErrorMessage, true);
      });
    }
  };

  myVideo.elt.onerror = () => {
    webcamErrorMessage = "CAMERA ERROR";
    setWebcamPlaceholder(webcamErrorMessage, true);
  };

  setTimeout(() => {
    if (!webcamReady && !webcamErrorMessage) {
      webcamErrorMessage = "ALLOW CAMERA IN BROWSER";
      setWebcamPlaceholder(webcamErrorMessage, true);
    }
  }, 3500);

  if (!window.isSecureContext) {
    webcamErrorMessage = "USE HTTPS OR LOCALHOST";
    setWebcamPlaceholder(webcamErrorMessage, true);
  }

  const faceOptions = {
    withLandmarks: true,
    withExpressions: true,
    withDescriptors: true,
    minConfidence: 0.5,
  };

  faceapi = ml5.faceApi(myVideo, faceOptions, faceReady);
}

function getWebcamMountSize() {
  const mount = document.getElementById("webcam-mount");
  if (!mount) {
    return { w: 420, h: 220 };
  }

  const rect = mount.getBoundingClientRect();
  const w = Math.max(320, Math.floor(rect.width));
  const h = Math.max(180, Math.floor(rect.height));
  return { w, h };
}

function resizeEmotionCanvas() {
  if (!webcamCanvas || !myVideo) {
    return;
  }

  const size = getWebcamMountSize();
  if (width !== size.w || height !== size.h) {
    resizeCanvas(size.w, size.h);
  }
}

function faceReady() {
  faceModelReady = true;
  faceapi.detect(gotFaces);
}

function gotFaces(error, result) {
  if (error) {
    console.log(error);
    webcamErrorMessage = "EMOTION MODEL ERROR";
    return;
  }

  detections = result || [];
  if (detections.length > 0) {
    const tracked = detections[0];
    updateEmotionTelemetry(tracked.expressions || {});
  }
  faceapi.detect(gotFaces);
}

function draw() {
  updateMicMeter();
  maybeFinalizeReactionWindow();

  if (!myVideo) {
    background(0);
    drawStatusText(webcamErrorMessage || "CAMERA NOT READY");
    return;
  }

  background(0);
  if (!webcamReady) {
    drawGridOverlay();
    drawStatusText(webcamErrorMessage || "STARTING CAMERA");
    return;
  }

  const frame = getVideoFrameRect();
  if (VIDEO_FIT_MODE === "contain") {
    drawWebcamHousing(frame);
  }
  image(myVideo, frame.x, frame.y, frame.w, frame.h);
  drawGridOverlay(frame);

  if (!faceModelReady) {
    drawStatusText("LOADING EMOTION MODEL");
    return;
  }

  if (detections.length > 0) {
    const d = detections[0];
    const expressions = d.expressions || {};
    const top = getDisplayEmotionState(expressions);

    push();
    translate(frame.x, frame.y);
    scale(frame.w / frame.sourceW, frame.h / frame.sourceH);
    drawBoxes(detections);
    drawLandmarks(detections);
    drawEmotionLabelOverFace(d, top.label, top.value);
    pop();

    drawEmotionHUD(expressions, top.label, top.value, top.entries);
    drawSurveillanceLines(d, frame);
  } else {
    drawStatusText("NO FACE DETECTED");
  }
}

function getVideoFrameRect() {
  const sourceW = (myVideo && myVideo.elt && myVideo.elt.videoWidth) || myVideo.width || CAPTURE_W;
  const sourceH = (myVideo && myVideo.elt && myVideo.elt.videoHeight) || myVideo.height || CAPTURE_H;

  const scale =
    VIDEO_FIT_MODE === "cover"
      ? Math.max(width / sourceW, height / sourceH)
      : Math.min(width / sourceW, height / sourceH);
  const w = sourceW * scale;
  const h = sourceH * scale;
  const x = (width - w) * 0.5;
  const y = (height - h) * 0.5;

  return { x, y, w, h, sourceW, sourceH };
}

function drawStatusText(message) {
  fill(255, 179, 71);
  noStroke();
  textAlign(CENTER, CENTER);
  textSize(11);
  text(message, width * 0.5, height * 0.5);
}

function setWebcamPlaceholder(message, visible) {
  const placeholder = select("#webcam-placeholder");
  if (!placeholder) {
    return;
  }

  if (message) {
    placeholder.html(message);
  }

  if (visible) {
    placeholder.show();
  } else {
    placeholder.hide();
  }
}

function drawGridOverlay(frame) {
  const minX = frame ? frame.x : 0;
  const maxX = frame ? frame.x + frame.w : width;
  const minY = frame ? frame.y : 0;
  const maxY = frame ? frame.y + frame.h : height;

  stroke(0, 212, 255, 45);
  strokeWeight(1);

  for (let x = minX; x < maxX; x += 28) {
    line(x, minY, x, maxY);
  }

  const frameHeight = max(1, maxY - minY);
  scanOffset = (scanOffset + 1.2) % frameHeight;
  for (let y = minY - frameHeight; y < maxY + frameHeight; y += 28) {
    const yy = minY + ((y - minY + scanOffset + frameHeight) % frameHeight);
    line(minX, yy, maxX, yy);
  }
}

function drawWebcamHousing(frame) {
  // Dark fill in letterbox areas so aspect-fit looks intentional.
  noStroke();
  fill(8, 12, 18, 235);
  rect(0, 0, width, frame.y);
  rect(0, frame.y + frame.h, width, height - (frame.y + frame.h));
  rect(0, frame.y, frame.x, frame.h);
  rect(frame.x + frame.w, frame.y, width - (frame.x + frame.w), frame.h);

  // Subtle cyan scan bars in letterbox margins.
  stroke(0, 212, 255, 45);
  strokeWeight(1);
  const barStep = 14;
  for (let y = frame.y + 4; y < frame.y + frame.h - 4; y += barStep) {
    if (frame.x > 10) {
      line(6, y, frame.x - 6, y);
    }
    if (frame.x + frame.w < width - 10) {
      line(frame.x + frame.w + 6, y, width - 6, y);
    }
  }

  // Main fitted-frame bezel and corners.
  noFill();
  stroke(255, 179, 71, 190);
  strokeWeight(1.5);
  rect(frame.x, frame.y, frame.w, frame.h, 4);

  stroke(0, 212, 255, 165);
  strokeWeight(1.2);
  const c = 10;
  // top-left
  line(frame.x, frame.y, frame.x + c, frame.y);
  line(frame.x, frame.y, frame.x, frame.y + c);
  // top-right
  line(frame.x + frame.w, frame.y, frame.x + frame.w - c, frame.y);
  line(frame.x + frame.w, frame.y, frame.x + frame.w, frame.y + c);
  // bottom-left
  line(frame.x, frame.y + frame.h, frame.x + c, frame.y + frame.h);
  line(frame.x, frame.y + frame.h, frame.x, frame.y + frame.h - c);
  // bottom-right
  line(frame.x + frame.w, frame.y + frame.h, frame.x + frame.w - c, frame.y + frame.h);
  line(frame.x + frame.w, frame.y + frame.h, frame.x + frame.w, frame.y + frame.h - c);
}

function drawBoxes(items) {
  for (let i = 0; i < items.length; i++) {
    const { _x, _y, _width, _height } = items[i].alignedRect._box;

    noFill();
    stroke(255, 179, 71);
    strokeWeight(1.5);
    rect(_x, _y, _width, _height);

    const corner = 8;
    line(_x, _y, _x + corner, _y);
    line(_x, _y, _x, _y + corner);

    line(_x + _width, _y, _x + _width - corner, _y);
    line(_x + _width, _y, _x + _width, _y + corner);

    line(_x, _y + _height, _x + corner, _y + _height);
    line(_x, _y + _height, _x, _y + _height - corner);

    line(_x + _width, _y + _height, _x + _width - corner, _y + _height);
    line(_x + _width, _y + _height, _x + _width, _y + _height - corner);
  }
}

function drawLandmarks(items) {
  for (let i = 0; i < items.length; i++) {
    const points = items[i].landmarks.positions;
    for (let j = 0; j < points.length; j++) {
      stroke(0, 212, 255);
      strokeWeight(1.4);
      point(points[j]._x, points[j]._y);
    }
  }
}

function drawEmotionLabelOverFace(d, label, value) {
  const box = d.alignedRect._box;
  const cx = box._x + box._width * 0.5;
  const topY = box._y - 6;

  textAlign(CENTER, BOTTOM);
  textSize(10);
  stroke(13, 13, 13);
  strokeWeight(3);
  fill(255, 179, 71);

  const perc = nf(value * 100, 2, 1) + "%";
  text(`${label.toUpperCase()} ${perc}`, cx, topY);
}

function drawEmotionHUD(expressions, label, value, entriesOverride = null) {
  const w = 136;
  const h = 104;
  const x = width - w - 8;
  const y = 8;

  let entries = Array.isArray(entriesOverride)
    ? entriesOverride.slice()
    : expressions.asSortedArray
      ? expressions.asSortedArray()
      : objectToSortedArray(expressions);
  entries = entries.slice(0, 3);

  push();
  noStroke();
  fill(8, 12, 18, 210);
  rect(x, y, w, h, 5);

  noFill();
  stroke(0, 212, 255);
  strokeWeight(1.2);
  rect(x, y, w, h, 5);

  fill(255, 179, 71);
  noStroke();
  textAlign(LEFT, TOP);
  textSize(8);
  text("EMOTION", x + 8, y + 6);

  fill(232, 232, 232);
  textSize(10);
  text(label.toUpperCase(), x + 8, y + 18);

  fill(0, 212, 255);
  textSize(7);
  text(`CONF ${nf(value * 100, 2, 1)}%`, x + 8, y + 31);

  stroke(0, 212, 255, 85);
  line(x + 8, y + 40, x + w - 8, y + 40);

  let barY = y + 46;
  const barW = w - 16;
  noStroke();

  for (let i = 0; i < entries.length; i++) {
    const name = entries[i].expression || entries[i].label || entries[i][0];
    const raw =
      typeof entries[i].probability === "number"
        ? entries[i].probability
        : entries[i].value || entries[i][1] || 0;

    fill(10, 22, 40, 220);
    rect(x + 8, barY, barW, 5, 2);

    fill(255, 179, 71);
    rect(x + 8, barY, barW * raw, 5, 2);

    fill(232, 232, 232);
    textSize(6.5);
    text(`${name} ${nf(raw * 100, 2, 0)}%`, x + 8, barY - 8);

    barY += 18;
  }
  pop();
}

function drawSurveillanceLines(d, frame) {
  const points = d.landmarks.positions || [];
  if (!points.length) {
    return;
  }

  const hudX = width - 128;
  let targetY = 54;
  const indexes = [
    floor(points.length * 0.32),
    floor(points.length * 0.5),
    floor(points.length * 0.68),
  ];

  for (let i = 0; i < indexes.length; i++) {
    const idx = constrain(indexes[i], 0, points.length - 1);
    const pt = points[idx];
    const sx = frame.x + (pt._x / frame.sourceW) * frame.w;
    const sy = frame.y + (pt._y / frame.sourceH) * frame.h;

    stroke(0, 212, 255, 120);
    strokeWeight(1);
    line(sx, sy, hudX, targetY);

    const t = (sin(frameCount * 0.06 + i) + 1) * 0.5;
    const px = lerp(sx, hudX, t);
    const py = lerp(sy, targetY, t);
    noStroke();
    fill(255, 179, 71);
    circle(px, py, 3);

    targetY += 18;
  }
}

function getTopExpressionFromMl5(expressions) {
  if (!expressions) {
    return { label: "neutral", value: 0 };
  }

  if (typeof expressions.asSortedArray === "function") {
    const sorted = expressions.asSortedArray();
    if (sorted && sorted.length > 0) {
      const top = sorted[0];
      return {
        label: top.expression || "neutral",
        value: top.probability || 0,
      };
    }
  }

  return getTopExpressionFallback(expressions);
}

function initializeEmotionTracking() {
  emotionEMA = {};
  for (let i = 0; i < EMOTION_KEYS.length; i++) {
    emotionEMA[EMOTION_KEYS[i]] = 0;
  }
  emotionTimeline = [];
  lastEmotionSnapshot = null;
  lastFaceSeenAt = 0;
  pendingReactionWindow = null;
  lastReactionSummary = null;
  reactionSummaryCounter = 0;
  lastReactionSummaryUsed = 0;
}

function normalizeExpressionObject(expressions) {
  const normalized = {};
  for (let i = 0; i < EMOTION_KEYS.length; i++) {
    const key = EMOTION_KEYS[i];
    const raw = expressions && typeof expressions[key] === "number" ? expressions[key] : 0;
    normalized[key] = constrain(raw, 0, 1);
  }
  return normalized;
}

function updateEmotionTelemetry(expressions) {
  const now = millis();
  const normalized = normalizeExpressionObject(expressions);

  for (let i = 0; i < EMOTION_KEYS.length; i++) {
    const key = EMOTION_KEYS[i];
    const prev = emotionEMA[key] || 0;
    const next = normalized[key];
    emotionEMA[key] = prev * (1 - EMOTION_SMOOTHING) + next * EMOTION_SMOOTHING;
  }

  const ranked = objectToSortedArray(emotionEMA);
  const top = ranked[0] || { expression: "neutral", probability: 0 };
  lastEmotionSnapshot = {
    label: top.expression || "neutral",
    value: top.probability || 0,
    entries: ranked.slice(0, 3),
    capturedAt: now,
  };
  lastFaceSeenAt = now;

  emotionTimeline.push({
    t: now,
    label: lastEmotionSnapshot.label,
    value: lastEmotionSnapshot.value,
  });
  if (emotionTimeline.length > EMOTION_HISTORY_MAX) {
    emotionTimeline.shift();
  }

  if (pendingReactionWindow && now <= pendingReactionWindow.endsAt) {
    pendingReactionWindow.samples.push({
      label: lastEmotionSnapshot.label,
      value: lastEmotionSnapshot.value,
      t: now,
    });
  }
}

function getDisplayEmotionState(fallbackExpressions = null) {
  const now = millis();
  if (lastEmotionSnapshot && now - lastFaceSeenAt <= EMOTION_STALE_MS) {
    return {
      label: lastEmotionSnapshot.label,
      value: lastEmotionSnapshot.value,
      entries: lastEmotionSnapshot.entries || [],
      stale: false,
    };
  }

  const fallbackTop = getTopExpressionFromMl5(fallbackExpressions || {});
  const fallbackEntries = objectToSortedArray(normalizeExpressionObject(fallbackExpressions || {})).slice(0, 3);
  return {
    label: fallbackTop.label || "neutral",
    value: fallbackTop.value || 0,
    entries: fallbackEntries,
    stale: true,
  };
}

function getEmotionPromptSnapshot() {
  const state = getDisplayEmotionState(null);
  const recentSignal = millis() - lastFaceSeenAt <= EMOTION_STALE_MS;
  if (!recentSignal) {
    return {
      available: false,
      label: "neutral",
      value: 0,
      entries: [],
      affect: "unknown",
    };
  }

  return {
    available: true,
    label: state.label,
    value: state.value,
    entries: (state.entries || []).slice(0, 3),
    affect: EMOTION_AFFECT_MAP[state.label] || state.label,
  };
}

function isInstructionalResponse(text) {
  if (!text || typeof text !== "string") {
    return false;
  }
  const t = text.toLowerCase();
  const patterns = [
    /\b(you should|you need to|i recommend|next step|action item)\b/,
    /\b(try|cut|reduce|start|stop|choose|ship|focus|decide|clarify|align|prioritize|track|cancel|delegate)\b/,
    /\b(would you like|option 1|option 2|option 3)\b/,
  ];
  return patterns.some((re) => re.test(t));
}

function maybeStartReactionWindow(aiText) {
  if (!isInstructionalResponse(aiText)) {
    return;
  }
  const now = millis();
  pendingReactionWindow = {
    startedAt: now,
    endsAt: now + REACTION_WINDOW_MS,
    samples: [],
  };
}

function maybeFinalizeReactionWindow() {
  if (!pendingReactionWindow) {
    return;
  }
  const now = millis();
  if (now < pendingReactionWindow.endsAt) {
    return;
  }
  finalizeReactionWindow();
}

function finalizeReactionWindow() {
  if (!pendingReactionWindow) {
    return;
  }

  const samples = pendingReactionWindow.samples || [];
  pendingReactionWindow = null;
  if (samples.length < 3) {
    return;
  }

  const scoreByLabel = {};
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const weight = Math.max(0.08, s.value || 0);
    scoreByLabel[s.label] = (scoreByLabel[s.label] || 0) + weight;
    total += weight;
  }

  let dominant = "neutral";
  let best = 0;
  for (let i = 0; i < EMOTION_KEYS.length; i++) {
    const label = EMOTION_KEYS[i];
    const score = scoreByLabel[label] || 0;
    if (score > best) {
      best = score;
      dominant = label;
    }
  }

  const confidence = total > 0 ? best / total : 0;
  if (confidence < MIN_EMOTION_REPORT_CONFIDENCE) {
    return;
  }

  reactionSummaryCounter += 1;
  lastReactionSummary = {
    id: reactionSummaryCounter,
    label: dominant,
    affect: EMOTION_AFFECT_MAP[dominant] || dominant,
    confidence,
    sampleCount: samples.length,
  };
}

function consumeReactionSummaryForPrompt() {
  if (!lastReactionSummary) {
    return null;
  }
  if (lastReactionSummary.id <= lastReactionSummaryUsed) {
    return null;
  }
  lastReactionSummaryUsed = lastReactionSummary.id;
  return lastReactionSummary;
}

function formatEmotionEntry(entry) {
  if (!entry) {
    return "";
  }
  const name = entry.expression || entry.label || "neutral";
  const value = typeof entry.probability === "number" ? entry.probability : entry.value || 0;
  return `${name}:${Math.round(value * 100)}%`;
}

function buildEmotionContextMessage() {
  const snapshot = getEmotionPromptSnapshot();
  const reaction = consumeReactionSummaryForPrompt();
  let context = [
    "Emotion telemetry from webcam is approximate and should be treated as uncertain.",
    "If confidence is low or signal is unavailable, ignore telemetry.",
    "If confidence is solid, include one brief sassy expression note in natural language.",
    "Callout must be short, observational, and non-invasive.",
    "Avoid mental health claims, private-cause guesses, or certainty.",
  ].join(" ");

  if (!snapshot.available || snapshot.value < MIN_EMOTION_REPORT_CONFIDENCE) {
    context += " Current emotion signal: unavailable_or_low_confidence.";
  } else {
    const topPercent = Math.round(snapshot.value * 100);
    const secondary = (snapshot.entries || [])
      .slice(1, 3)
      .map((entry) => formatEmotionEntry(entry))
      .filter(Boolean)
      .join(", ");
    context += ` Current emotion signal: ${snapshot.label} at ${topPercent} percent. Overall vibe: ${snapshot.affect}.`;
    if (secondary) {
      context += ` Secondary cues: ${secondary}.`;
    }
  }

  if (reaction) {
    const reactionPercent = Math.round(reaction.confidence * 100);
    context += ` Post-instruction reaction snapshot: ${reaction.label} at ${reactionPercent} percent. Tone: ${reaction.affect}.`;
    context += " Reference this briefly only if it helps the user move forward.";
  }

  return context;
}

function buildExpressionCallout() {
  const snapshot = getEmotionPromptSnapshot();
  if (!snapshot.available || snapshot.value < MIN_EXPRESSION_CALLOUT_CONFIDENCE) {
    return "";
  }

  const templateByLabel = {
    neutral: [
      "Ohh, you look locked in today.",
      "You look neutral today, very steady.",
      "You look focused right now.",
    ],
    happy: [
      "I saw your smile right there.",
      "Okay, you look happy for a second.",
      "You look amused, I caught that.",
    ],
    sad: [
      "You look low energy today.",
      "I can see you look a bit drained.",
      "You look quiet and tired right now.",
    ],
    angry: [
      "You look frustrated, I see it.",
      "That hit a nerve, huh.",
      "You look tense right now.",
    ],
    fearful: [
      "You look cautious today.",
      "I can see hesitation there.",
      "You look unsure about this step.",
    ],
    disgusted: [
      "You look skeptical today.",
      "You are not buying this yet.",
      "I saw that skeptical face.",
    ],
    surprised: [
      "Ohh, that surprised you.",
      "I saw that surprise on your face.",
      "You did not expect that, clearly.",
    ],
  };
  const options = templateByLabel[snapshot.label];
  if (Array.isArray(options) && options.length > 0) {
    return random(options);
  }
  return `You look ${snapshot.affect}.`;
}

function responseMentionsExpression(text) {
  if (!text) {
    return false;
  }

  const t = text.toLowerCase();
  const markers = [
    "scan",
    "expression",
    "reaction",
    "you look",
    "you seem",
    "face",
    "mood",
    "skeptical",
    "frustrated",
    "amused",
    "focused",
    "cautious",
    "lower energy",
    "sharp reaction",
  ];

  return markers.some((marker) => t.includes(marker));
}

function normalizeModelOutput(text) {
  if (!text || typeof text !== "string") {
    return "";
  }

  return text
    .replace(/\r\n/g, "\n")
    .trim();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseInlineMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderBotMessageHtml(text) {
  const escaped = escapeHtml(normalizeModelOutput(text));
  const lines = escaped.split("\n");
  const htmlParts = [];
  let paragraph = [];
  let listType = null; // "ul" | "ol"

  const closeList = () => {
    if (listType) {
      htmlParts.push(`</${listType}>`);
      listType = null;
    }
  };

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const body = paragraph.map((line) => parseInlineMarkdown(line)).join("<br>");
      htmlParts.push(`<p>${body}</p>`);
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) {
      flushParagraph();
      closeList();
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      htmlParts.push(`<p><strong>${parseInlineMarkdown(headingMatch[1])}</strong></p>`);
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        htmlParts.push("<ul>");
        listType = "ul";
      }
      htmlParts.push(`<li>${parseInlineMarkdown(bulletMatch[1])}</li>`);
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph();
      if (listType !== "ol") {
        closeList();
        htmlParts.push("<ol>");
        listType = "ol";
      }
      htmlParts.push(`<li>${parseInlineMarkdown(orderedMatch[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  flushParagraph();
  closeList();
  return htmlParts.join("");
}

function renderUserMessageHtml(text) {
  const escaped = escapeHtml(normalizeModelOutput(text));
  return escaped.replace(/\n/g, "<br>");
}

function getTopExpressionFallback(expressions) {
  let bestLabel = "neutral";
  let bestValue = 0;

  for (let key in expressions) {
    const v = expressions[key];
    if (typeof v === "number" && v > bestValue) {
      bestValue = v;
      bestLabel = key;
    }
  }

  return { label: bestLabel, value: bestValue };
}

function objectToSortedArray(expressions) {
  const arr = [];
  for (let key in expressions) {
    const v = expressions[key];
    if (typeof v === "number") {
      arr.push({ expression: key, probability: v });
    }
  }

  arr.sort((a, b) => b.probability - a.probability);
  return arr;
}

function appendMessage(role, text) {
  const msg = createElement("div");
  msg.addClass("msg");
  msg.addClass(role === "user" ? "user" : "bot");
  const html = role === "bot" ? renderBotMessageHtml(text) : renderUserMessageHtml(text);
  msg.html(html);
  msg.parent(myOutput);

  if (myOutput && myOutput.elt) {
    myOutput.elt.scrollTop = myOutput.elt.scrollHeight;
  }
}

//for easier use, go to the chat function also on ENTER key press
function keyPressed() {
  if (keyCode === ENTER) {
    chat();
  }
}

//a function to limit the user's input to 50 words to help control cost
function limitWords(text) {
  let words = text.trim().split(/\s+/);
  return words.slice(0, 50).join(" ");
}

function getConversationSliceForModel(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  if (history.length <= MAX_CONTEXT_MESSAGES + 1) {
    return history.slice();
  }

  const system = history[0];
  const tail = history.slice(-MAX_CONTEXT_MESSAGES);
  return [system, ...tail];
}

async function callReplicateProxy(requestMessages) {
  const endpoint = IS_GITHUB_PAGES
    ? "https://itp-ima-replicate-proxy.web.app/api/create_n_get"
    : "/api/chat";
  const payload = IS_GITHUB_PAGES
    ? {
        model: "openai/gpt-5-mini",
        input: { messages: requestMessages, temperature: 0.55, top_p: 0.9 },
      }
    : { messages: requestMessages };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) throw new Error(`Chat service HTTP ${response.status}`);
  const data = await response.json();
  const text = IS_GITHUB_PAGES
    ? (Array.isArray(data.output) ? data.output.join("") : data.output || data.output_text)
    : data.text;
  if (data.error || typeof text !== "string" || !text.trim()) {
    throw new Error("The chat service returned no reply. Please try again.");
  }
  return { text, sources: [] };
}

// where the API call happens and where we save all the chat history so the bot has memory of what has been talked about within the session
async function chat(overrideInput = null) {
  const rawText = typeof overrideInput === "string" ? overrideInput : myInput.value();
  const inputValue = limitWords(rawText); //save the user's input (limited to 50 words) into inputValue
  if (!inputValue || inputValue.length <= 0) {
    return; //if there's no input, return, do not continue
  }

  appendMessage("user", inputValue);

  //add the user's message to the conversation history
  conversationHistory.push({ role: "user", content: inputValue });
  const historyForModel = getConversationSliceForModel(conversationHistory);
  const emotionContext = buildEmotionContextMessage();
  const requestMessages = emotionContext
    ? [...historyForModel, { role: "system", content: emotionContext }]
    : historyForModel;

  try {
    const fallback = await callReplicateProxy(requestMessages);
    const rawTextOutput = fallback.text || "";

    let generatedResponse = normalizeModelOutput(rawTextOutput);
    if (!generatedResponse) {
      generatedResponse = "I processed that through proxy mode but got no usable output. Ask again with a narrower question.";
    }

    const callout = buildExpressionCallout();
    if (callout && !responseMentionsExpression(generatedResponse)) {
      generatedResponse = `${callout} ${generatedResponse}`;
    }

    //add the bot's message to the conversation history
    conversationHistory.push({ role: "assistant", content: generatedResponse });
    maybeStartReactionWindow(generatedResponse);

    appendMessage("bot", generatedResponse);
    myInput.value(""); //clear the input field
    speakResponse(generatedResponse);
  } catch (error) {
    console.log("Chat request error:", error);
    appendMessage("bot", "Request failed. Check network, model settings, and API credentials.");
  }
}
