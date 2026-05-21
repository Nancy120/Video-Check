

'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ── Page Object Model (POM) 

class VideoPage {
  constructor(filePath) {
    this.filePath    = filePath;
    this.fileName    = path.basename(filePath);
    this.duration    = 0;
    this.hasVideo    = false;
    this.hasAudio    = false;
    this.hasSubtitle = false;
    this.videoCodec  = '';
    this.width       = 0;
    this.height      = 0;
    this.fps         = 0;
    this.issues      = [];
    this.warnings    = [];
    this.passed      = false;
  }
  addIssue(msg)   { this.issues.push(msg); }
  addWarning(msg) { this.warnings.push(msg); }
}

// ── VideoValidator

class VideoValidator {

  // Run ffprobe and fill stream metadata
  static probeStreams(page) {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      page.filePath
    ];
    const result = spawnSync('ffprobe', args, { encoding: 'utf8' });
    const data   = JSON.parse(result.stdout);
    const fmt    = data.format || {};

    page.duration = parseFloat(fmt.duration || 0);

    for (const stream of (data.streams || [])) {
      if (stream.codec_type === 'video') {
        page.hasVideo   = true;
        page.videoCodec = stream.codec_name || '';
        page.width      = stream.width  || 0;
        page.height     = stream.height || 0;
        const [num, den] = (stream.r_frame_rate || '0/1').split('/');
        page.fps = den > 0 ? parseFloat(num) / parseFloat(den) : 0;
      }
      if (stream.codec_type === 'audio')    page.hasAudio    = true;
      if (stream.codec_type === 'subtitle') page.hasSubtitle = true;
    }
  }

  // Check-1: Audio stream present?
  static checkAudio(page) {
    if (!page.hasAudio) {
      page.addIssue('No audio stream detected while streaming.');
      return false;
    }
    return true;
  }

  // Check-2: Freeze/stuck frames >
  static checkFreezeFrames(page, threshold = 6) {
    const args = [
      '-i', page.filePath,
      '-vf', `freezedetect=n=-60dB:d=${threshold}`,
      '-f', 'null', '-'
    ];
    const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    const output = (result.stderr || '') + (result.stdout || '');

    const freezeStarts = [];
    const freezeDurs   = [];

    for (const line of output.split('\n')) {
      const startM = line.match(/freeze_start:\s*([\d.]+)/);
      const durM   = line.match(/freeze_duration:\s*([\d.]+)/);
      if (startM) freezeStarts.push(parseFloat(startM[1]));
      if (durM)   freezeDurs.push(parseFloat(durM[1]));
    }

    if (freezeStarts.length > 0) {
      const details = freezeStarts
        .map((s, i) => `[start=${s.toFixed(1)}s, duration=${(freezeDurs[i] || 0).toFixed(1)}s]`)
        .join(', ');
      page.addIssue(`Video stuck/frozen for >=${threshold}s detected at: ${details}`);
      return false;
    }
    return true;
  }

  // Check-3: Black/White blank screen 
  static checkBlankScreen(page, threshold = 6) {
    // Black screen
    const blackArgs = [
      '-i', page.filePath,
      '-vf', `blackdetect=d=${threshold}:pix_th=0.10`,
      '-f', 'null', '-'
    ];
    const blackOut = (spawnSync('ffmpeg', blackArgs, { encoding: 'utf8' }).stderr || '');

    // White screen (invert then blackdetect)
    const whiteArgs = [
      '-i', page.filePath,
      '-vf', `negate,blackdetect=d=${threshold}:pix_th=0.10`,
      '-f', 'null', '-'
    ];
    const whiteOut = (spawnSync('ffmpeg', whiteArgs, { encoding: 'utf8' }).stderr || '');

    const parseEvents = (output, label) => {
      const events = [];
      for (const line of output.split('\n')) {
        const startM = line.match(/black_start:\s*([\d.]+)/);
        const durM   = line.match(/black_duration:\s*([\d.]+)/);
        if (startM && durM) {
          events.push(`${label} [start=${parseFloat(startM[1]).toFixed(1)}s, dur=${parseFloat(durM[1]).toFixed(1)}s]`);
        }
      }
      return events;
    };

    const allEvents = [
      ...parseEvents(blackOut, 'Black screen'),
      ...parseEvents(whiteOut, 'White screen'),
    ];

    if (allEvents.length > 0) {
      page.addIssue(`Blank screen (>=${threshold}s): ${allEvents.join(', ')}`);
      return false;
    }
    return true;
  }

  // Check-4: Subtitle? (warning only)
  static checkSubtitle(page) {
    if (!page.hasSubtitle) {
      page.addWarning('No subtitle stream found in this video.');
    }
    return true;
  }

  // Master validate
  static validate(page) {
    console.log(`\n${'─'.repeat(62)}`);
    console.log(` Validating : ${page.fileName}`);
    console.log(`${'─'.repeat(62)}`);

    if (!fs.existsSync(page.filePath)) {
      page.addIssue('File not found on disk.');
      page.passed = false;
      VideoValidator._printResult(page);
      return page;
    }

    VideoValidator.probeStreams(page);
    console.log(` [INFO] Duration : ${page.duration.toFixed(2)}s`);
    console.log(` [INFO] Video    : ${page.videoCodec} ${page.width}x${page.height} @ ${page.fps.toFixed(0)}fps`);
    console.log(` [INFO] Audio    : ${page.hasAudio    ? 'PRESENT' : 'MISSING'}`);
    console.log(` [INFO] Subtitle : ${page.hasSubtitle ? 'PRESENT' : 'not found'}`);
    console.log('\n Running checks...');

    const audioOk  = VideoValidator.checkAudio(page);
    const freezeOk = VideoValidator.checkFreezeFrames(page);
    const blankOk  = VideoValidator.checkBlankScreen(page);
    VideoValidator.checkSubtitle(page);

    page.passed = audioOk && freezeOk && blankOk;
    VideoValidator._printResult(page);
    return page;
  }

  static _printResult(page) {
    console.log('');
    if (page.passed) {
      console.log('RESULT: PASS');
      console.log('MESSAGE: This video meets streaming requirements and contains audio.');
      for (const w of page.warnings) {
        console.log('WARNING: ' + w);
      }
    } else {
      console.log('RESULT: FAIL');
      for (const issue of page.issues) {
        const message = VideoValidator._formatIssueMessage(issue);
        console.log(`MESSAGE: ${message}`);
        console.log(`  Detail: ${issue}`);
      }
      for (const w of page.warnings) {
        console.log('WARNING: ' + w);
      }
    }
  }

  static _formatIssueMessage(issue) {
    const low = (issue || '').toLowerCase();
    if (low.includes('file not found')) return 'File not found on disk.';
    if (low.includes('no audio') || low.includes('audio')) return 'Missing audio track.';
    if (low.includes('stuck') || low.includes('frozen') || low.includes('freeze')) return 'Frozen or stuck frames detected.';
    if (low.includes('black') || low.includes('white') || low.includes('blank')) return 'Extended black or white screen detected.';
    return 'The video failed validation.';
  }
}

// ── VideoStreamingTestSuite

class VideoStreamingTestSuite {
  constructor(videoPaths) {
    this.videoPaths = videoPaths;
    this.results    = [];
  }

  runAll() {
    console.log('\nVideo Streaming Quality Automation Suite');
    console.log('Practical Assignment 1 — Node.js (JavaScript)');
    console.log(`Total videos to validate: ${this.videoPaths.length}\n`);

    for (const filePath of this.videoPaths) {
      const page = new VideoPage(filePath);
      VideoValidator.validate(page);
      this.results.push(page);
    }

    this._printSummary();
  }

  _printSummary() {
    const passed = this.results.filter(r => r.passed);
    const failed = this.results.filter(r => !r.passed);

    console.log(`\n${'='.repeat(62)}`);
    console.log('  FINAL SUMMARY REPORT');
    console.log(`${'='.repeat(62)}`);
    console.log(` Total   : ${this.results.length}`);
    console.log(` Passed  : ${passed.length} `);
    console.log(` Failed  : ${failed.length} `);
    console.log(`${'─'.repeat(62)}`);

    for (const r of this.results) {
      const status = r.passed ? 'PASS' : 'FAIL';
      console.log(` ${status}  |  ${r.fileName}`);
      for (const issue of r.issues) {
        console.log(`         - ${issue}`);
      }
      for (const w of r.warnings) {
        console.log('         Warning: ' + w);
      }
    }
    console.log(`${'='.repeat(62)}\n`);
  }
}




const VIDEO_DIR = 'C:\\Users\\nancy\\Downloads\\All video';

const videoFiles = [
  'Sample_1.mp4',
  'Sample_2.mp4',
  'Sample_3.mp4',
  'Sample_4.mp4',
  'Sample_5.mp4',
  'Sample_6.mp4',
  'sample_7.mp4',
].map(f => path.join(VIDEO_DIR, f));

const suite = new VideoStreamingTestSuite(videoFiles);
suite.runAll();
