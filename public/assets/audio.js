// Chiptune 16-bit lean: loop chiptune dengan lapis shimmer + SFX, tanpa file audio.
const NOTES = {
  C2: 65.41, D2: 73.42, E2: 82.41, F2: 87.31, G2: 98.0, A2: 110.0, B2: 123.47,
  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0, B3: 246.94,
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
  C6: 1046.5, E6: 1318.51, G6: 1567.98,
};

const CHORDS = [
  { bass: 'C2', arp: ['C4', 'E4', 'G4', 'C5'] },
  { bass: 'A2', arp: ['A3', 'C4', 'E4', 'A4'] },
  { bass: 'F2', arp: ['F3', 'A3', 'C4', 'F4'] },
  { bass: 'G2', arp: ['G3', 'B3', 'D4', 'G4'] },
];

const LEAD_PATTERN = [0, 1, 2, 3, 1, 2, 0, 2, 3, 2, 1, 0, 2, 1, 3, 2];
const BASS_STEPS = [0, 4, 8, 12];

export class Chiptune {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.noiseBuffer = null;
    this.playing = false;
    this.timer = null;
    this.step = 0;
    this.nextTime = 0;
    this.bpm = 124;
    this.stepDuration = 60 / this.bpm / 4;
    this.muted = true;
  }

  ensure() {
    if (!this.ctx) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      this.ctx = new AudioCtor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.26;
      this.master.connect(this.ctx.destination);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 0.38;
      this.sfxBus.connect(this.ctx.destination);

      const length = Math.floor(this.ctx.sampleRate * 0.25);
      this.noiseBuffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  start() {
    if (this.playing) return;
    if (!this.ensure()) return;
    this.playing = true;
    this.muted = false;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0.26, now);
    this.nextTime = now + 0.06;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop() {
    this.playing = false;
    this.muted = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  toggle() {
    if (this.playing) this.stop();
    else this.start();
    return this.playing;
  }

  schedule() {
    if (!this.playing || !this.ctx) return;
    while (this.nextTime < this.ctx.currentTime + 0.14) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += this.stepDuration;
      this.step = (this.step + 1) % 64;
    }
  }

  playStep(step, time) {
    const chord = CHORDS[Math.floor(step / 16) % CHORDS.length];
    const local = step % 16;

    const arpNote = chord.arp[LEAD_PATTERN[local] % chord.arp.length];
    this.note(NOTES[arpNote], time, this.stepDuration * 0.86, 'square', 0.085);
    if (local % 4 === 2) {
      this.note(NOTES[arpNote] * 2, time, this.stepDuration * 0.5, 'sine', 0.03);
    }

    if (BASS_STEPS.includes(local)) {
      const octave = local === 8 ? 2 : 1;
      this.note(NOTES[chord.bass] * octave, time, this.stepDuration * 1.7, 'triangle', 0.16);
    }

    if (step % 2 === 0) this.noise(time, 0.028, 0.025, 7600);
    if (local === 0 || local === 8) this.kick(time);
    if (local === 4 || local === 12) this.noise(time, 0.09, 0.05, 2400);
  }

  note(freq, time, duration, type, volume) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(volume, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(time);
    osc.stop(time + duration + 0.03);
  }

  noise(time, duration, volume, highpass) {
    if (!this.noiseBuffer) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = highpass;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(time);
    source.stop(time + duration);
  }

  kick(time) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.12);
    gain.gain.setValueAtTime(0.22, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(time);
    osc.stop(time + 0.16);
  }

  // ---------------------------------------------------------- SFX

  // Musik sedikit mengalah saat efek tombol bunyi supaya SFX tidak tenggelam.
  duck() {
    const gain = this.master.gain;
    const now = this.ctx.currentTime;
    if (gain.cancelAndHoldAtTime) {
      gain.cancelAndHoldAtTime(now);
    } else {
      const current = gain.value;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(current, now);
    }
    gain.linearRampToValueAtTime(0.14, now + 0.012);
    gain.setValueAtTime(0.14, now + 0.16);
    gain.linearRampToValueAtTime(0.26, now + 0.34);
  }

  sfx(fn) {
    // Tombol mute mematikan seluruh suara, termasuk efek.
    if (!this.playing || !this.ensure()) return;
    this.duck();
    fn(this.ctx.currentTime);
  }

  playTone(freq, offset, duration, type = 'square', volume = 0.18) {
    const time = this.ctx.currentTime + offset;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(volume, time + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    osc.connect(gain);
    gain.connect(this.sfxBus);
    osc.start(time);
    osc.stop(time + duration + 0.02);
  }

  click() {
    this.sfx(() => this.playTone(880, 0, 0.035, 'square', 0.12));
  }

  select() {
    this.sfx(() => {
      this.playTone(660, 0, 0.05, 'square', 0.16);
      this.playTone(990, 0.05, 0.08, 'square', 0.14);
    });
  }

  confirm() {
    this.sfx(() => {
      [523.25, 659.25, 783.99].forEach((f, i) => this.playTone(f, i * 0.07, 0.1, 'square', 0.16));
    });
  }

  success() {
    this.sfx(() => {
      const melody = [
        [523.25, 0, 0.12],
        [659.25, 0.12, 0.12],
        [783.99, 0.24, 0.12],
        [1046.5, 0.36, 0.3],
        [783.99, 0.52, 0.1],
        [1046.5, 0.62, 0.34],
      ];
      melody.forEach(([f, offset, duration]) => {
        this.playTone(f, offset, duration, 'square', 0.16);
        this.playTone(f * 2, offset, duration * 0.7, 'triangle', 0.05);
      });
    });
  }

  error() {
    this.sfx(() => {
      this.playTone(220, 0, 0.14, 'sawtooth', 0.16);
      this.playTone(147, 0.12, 0.2, 'sawtooth', 0.14);
    });
  }
}

export const music = new Chiptune();
