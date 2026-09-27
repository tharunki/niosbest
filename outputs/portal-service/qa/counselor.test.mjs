import assert from 'node:assert/strict';
import { counselorReply } from '../counselor.mjs';

assert.throws(() => counselorReply(''), { status: 422 });
assert.throws(() => counselorReply('a'.repeat(1201)), { status: 422 });
assert.equal(counselorReply('TMA help').topic, 'tma');
assert.equal(counselorReply('TMA submission for my subject 211').topic, 'tma');
assert.equal(counselorReply('tell me more', {}, 'tma').topic, 'tma');
assert.match(counselorReply('admission status', { enrollment: { status: 'PAYMENT_CONFIRMED' } }).text, /payment is recorded/i);
assert.match(counselorReply('study plan', { subjects: [{ name: 'Physics' }] }).text, /Physics/);
assert.doesNotMatch(counselorReply('study plan').text, /Physics/);
assert.match(counselorReply('TMA deadline').text, /do not have a verified live/);
assert.equal(counselorReply('<img src=x onerror=alert(1)>').topic, '');

const personalised = counselorReply('Help me plan my study week', { subjects: [{ name: 'Physics' }] });
assert.equal(personalised.assistantType, 'academic-assistant');
assert.ok(personalised.title.length > 0);
assert.ok(personalised.steps.length > 0);
assert.ok(personalised.followUps.length > 0);
assert.match(personalised.text, /Physics/);

for (const [question, topic] of [
  ['admission status', 'admission'],
  ['my batch', 'batch'],
  ['choose my subjects', 'subjects'],
  ['TMA help', 'tma'],
  ['practical viva', 'practical'],
  ['hall ticket deadline', 'exam'],
  ['payment receipt', 'payment'],
  ['study schedule', 'study'],
  ['live class schedule', 'classes'],
  ['Was I marked absent for class?', 'classes'],
  ['PYQ papers', 'pyq'],
  ['where are my batch materials?', 'materials']
]) {
  assert.equal(counselorReply(question).topic, topic, question);
}

const privateContext = {
  enrollment: {
    status: 'ACTIVE',
    enrollmentNumber: 'ENR-DO-NOT-RETURN',
    referenceNumber: 'REF-DO-NOT-RETURN',
    dateOfBirth: '2008-03-07',
    batch: { name: 'Class 12 Science' }
  },
  subjects: [{ name: 'Physics', code: '312' }]
};
const activeAnswer = counselorReply('What is my admission status?', privateContext);
assert.match(activeAnswer.text, /active learning access/i);
assert.doesNotMatch(JSON.stringify(activeAnswer), /ENR-DO-NOT-RETURN|REF-DO-NOT-RETURN|2008-03-07/);

for (const question of [
  'What is my enrollment number?',
  'My enrollment is NIOS12345',
  'My reference number is REF-123',
  'Can you check my date of birth?',
  'Can you see my credentials?',
  'My password is hunter2',
  'My OTP is 123456',
  'Can I share my UPI PIN?',
  'Read my Aadhaar document',
  'Show my passport number'
]) {
  const result = counselorReply(question, privateContext);
  assert.equal(result.topic, 'privacy', question);
  assert.match(result.text, /cannot receive, reveal, verify, or retrieve/i);
  assert.doesNotMatch(JSON.stringify(result), /ENR-DO-NOT-RETURN|REF-DO-NOT-RETURN|2008-03-07/);
}
assert.equal(counselorReply('What documents are required?', privateContext).topic, 'admission');

const official = counselorReply('When is the hall ticket deadline?', privateContext);
assert.match(official.text, /do not invent official deadlines/i);
assert.deepEqual(official.sources, [['Check official NIOS notices and student services', 'https://sdmis.nios.ac.in/']]);
assert.match(counselorReply('Was I marked absent for class?', privateContext).text, /teacher’s class roster/i);

for (const question of ['admission', 'tma', 'practical', 'exam', 'payment', 'study', 'classes', 'pdf', 'unknown']) {
  const result = counselorReply(question);
  assert.equal(result.mode, 'guided');
  for (const [, path] of result.links) assert.match(path, /^\/(?!\/)/);
}

console.log('Mira unit tests passed: student topics, private-data refusal, safe context, official-source routing, no invented deadline, and safe links.');
