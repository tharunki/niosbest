// Mira is an authenticated Student Desk guide, not an official NIOS decision-maker.
// It deliberately receives only enrolment status, batch metadata, and selected subjects.
// It never returns portal credentials, document URLs, payment secrets, or private identifiers.

const OFFICIAL_NIOS_PORTAL = 'https://sdmis.nios.ac.in/';
const ACADEMY_SUPPORT = '/contact.html#form';
const STUDENT_DESK = '/dashboard';

const cleanText = (value, maxLength = 100) => String(value || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength);

function selectedSubjects(subjects) {
  if (!Array.isArray(subjects)) return [];
  return subjects
    .map(subject => ({ name: cleanText(subject?.name, 80), code: cleanText(subject?.code, 24) }))
    .filter(subject => subject.name)
    .slice(0, 10);
}

function subjectSummary(subjects) {
  const names = selectedSubjects(subjects).map(subject => subject.name);
  return names.length ? names.join(', ') : 'your selected subjects';
}

function safeBatchName(enrollment) {
  return cleanText(enrollment?.batch?.name || enrollment?.batchName, 120);
}

function response(topic, title, text, steps = [], followUps = [], links = [], sources = []) {
  // Preserve the established API contract used by both Student Desk clients.
  return {
    topic,
    title,
    text,
    steps: steps.map(step => cleanText(step, 360)).filter(Boolean).slice(0, 5),
    followUps: followUps.map(item => cleanText(item, 100)).filter(Boolean).slice(0, 4),
    links: links.filter(([label, path]) => cleanText(label, 100) && /^\/(?!\/)/.test(String(path || ''))).slice(0, 3),
    sources: sources.filter(([label, url]) => cleanText(label, 100) && /^https:\/\//.test(String(url || ''))).slice(0, 2),
    mode: 'guided',
    assistantType: 'academic-assistant'
  };
}

function officialNoticeSource() {
  return [['Check official NIOS notices and student services', OFFICIAL_NIOS_PORTAL]];
}

function enrollmentSummary(enrollment = {}) {
  const status = String(enrollment.status || '').trim().toUpperCase();
  const batch = safeBatchName(enrollment);
  const namedBatch = batch ? ` for ${batch}` : '';
  const summaries = {
    DOCUMENTS_SUBMITTED_PENDING_PAYMENT: `Your subject choices and documents are recorded${namedBatch}, but full payment is still required before the paid Student Desk opens.`,
    PAYMENT_CONFIRMED: `Your payment is recorded${namedBatch}. The academy can now review the application and start its official-registration process.`,
    VERIFICATION_IN_PROGRESS: `The academy has marked official verification as in progress${namedBatch}. Learning access remains restricted until the academy confirms it.`,
    NEEDS_ACTION: 'The academy needs a secure clarification or document update before the application can continue. Check the admission-status page or contact academy support.',
    ACTIVE: `Your academy record shows active learning access${namedBatch}. Your desk should show only materials and classes assigned to your batch and subjects.`
  };
  return summaries[status] || 'I cannot see a completed batch-admission record for this account yet. An individual resource purchase does not create a batch admission.';
}

function isSensitiveQuestion(query) {
  // Asking general process questions is allowed. This guard applies when the student asks
  // Mira to receive, reveal, verify, or retrieve a secret/private identifier.
  const secretIntent = /\b(password|passcode|one[ -]?time (?:passcode|password)|otp|verification code|security code|upi pin|card (?:number|details|cvv|pin)|cvv|bank (?:account|details|number|ifsc)|(?:login )?credentials?|secret key|api key)\b/i;
  const privateIdentifierIntent = /\b(?:enrol(?:l?ment)?|registration|reference)\s*(?:number|no\.?|id)\b|\b(?:date of birth|dob)\b|\b(?:aadhaar|aadhar|pan(?:\s+number)?|passport(?:\s+number)?|full id|identity number)\b/i;
  // This catches an actual value even when a direct API caller omits the word
  // "number" (the browser preflight blocks it before transmission as well).
  const privateIdentifierValue = /\b(?:enrol(?:l?ment)?|registration|reference)\s*(?:number|no\.?|id)?\s*(?:is|:|=|#|-)\s*[a-z0-9-]{5,}\b|\b(?:date of birth|dob)\s*(?:is|:|=|#|-)\s*\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/i;
  const documentInspectionIntent = /\b(?:read|check|verify|see|open|show|send|paste|share|upload)\b[^.]{0,55}\b(?:document|aadhaar|aadhar|passport|pan|id proof|photo id|signature)\b|\b(?:document|aadhaar|aadhar|passport|pan|id proof|photo id|signature)\b[^.]{0,55}\b(?:read|check|verify|see|open|show|send|paste|share)\b/i;
  return secretIntent.test(query) || privateIdentifierIntent.test(query) || privateIdentifierValue.test(query) || documentInspectionIntent.test(query);
}

function classifyTopic(query, previousTopic) {
  if (isSensitiveQuestion(query)) return 'privacy';
  if (/\b(?:pyq|previous(?:\s+year)?\s+(?:paper|question)|past\s+paper)\b/i.test(query)) return 'pyq';
  // These requests commonly include "batch" or "subject" as a qualifier. Keep the
  // learner on the resource/class answer instead of bouncing them to generic batch help.
  if (/\b(?:downloads?|pdfs?|materials?|resources?|notes?|guides?)\b/i.test(query)) return 'materials';
  if (/\b(?:classes?|zoom|meet(?:ing)?s?|recordings?|live|attendance|present|absent)\b/i.test(query)) return 'classes';
  if (/\b(?:tma|assignment|homework|tutor marked)\b/i.test(query)) return 'tma';
  if (/\b(?:subject|combination|elective|choose|selection)\b/i.test(query)) return 'subjects';
  if (/\b(?:batch|stream|block|course)\b/i.test(query)) return 'batch';
  if (/\b(?:practical|lab|viva|experiment)\b/i.test(query)) return 'practical';
  if (/\b(?:hall.?ticket|exam|deadline|date|centre|center|ode)\b/i.test(query)) return 'exam';
  if (/\b(?:fee|pay|payment|refund|receipt|bill|checkout)\b/i.test(query)) return 'payment';
  if (/\b(?:study|plan|week|revision|timetable|schedule)\b/i.test(query)) return 'study';
  if (/\b(?:admission|verif|status|enrol|enroll|documents?|application)\b/i.test(query)) return 'admission';
  if (/\b(?:hello|hi|hey|help|what can you)\b/i.test(query)) return 'welcome';
  if (/^(?:and\s+|what next|how|tell me more|yes|more|then|why)\b/i.test(query)) return previousTopic;
  return '';
}

export function counselorReply(message, context = {}, previousTopic = '') {
  if (typeof message !== 'string' || !message.trim() || message.length > 1200) {
    throw Object.assign(new Error('Enter a question between 1 and 1,200 characters.'), { status: 422 });
  }

  const question = message.trim();
  const query = question.toLowerCase();
  const enrollment = context.enrollment && typeof context.enrollment === 'object' ? context.enrollment : {};
  const subjects = selectedSubjects(context.subjects);
  const subjectList = subjectSummary(subjects);
  const batchName = safeBatchName(enrollment);
  const hasActiveAccess = String(enrollment.status || '').toUpperCase() === 'ACTIVE';
  const topic = classifyTopic(query, previousTopic);
  const isAttendanceQuestion = /\b(?:attendance|present|absent)\b/i.test(query);
  const classGuidance = isAttendanceQuestion
    ? 'Attendance is recorded from the teacher’s class roster, not by Mira. Check the relevant class card or ask the academy to review a missing or incorrect attendance record; do not share a meeting password or host link.'
    : hasActiveAccess
      ? 'Live classes and recordings are limited to your active batch and selected subjects. The Join button appears only when the teacher’s scheduled class allows it; a restricted or ended class will not expose its meeting link.'
      : 'Live classes remain restricted until the academy confirms your admission access. You can still use this time to review your selected subjects and complete any requested admission step.';

  const answers = {
    privacy: response(
      'privacy',
      'Keep private information out of chat',
      'Mira cannot receive, reveal, verify, or retrieve passwords, OTPs, PINs, card or bank details, Aadhaar/PAN/passport numbers, document images, date of birth, enrolment numbers, or reference numbers. Use the signed-in admission form or contact the academy for a secure update instead.',
      [
        'Do not paste a secret, full ID number, document image, or payment detail here.',
        'For a document problem, use the secure admission workflow rather than email or chat.',
        'If you already shared a password, OTP, card detail, or PIN elsewhere, change or block it through the relevant official provider immediately.'
      ],
      ['What documents are required?', 'What is my admission status?', 'How do I select subjects?'],
      [['Open secure admission status', '/admission-intake'], ['Contact academy support', ACADEMY_SUPPORT]]
    ),
    welcome: response(
      'welcome',
      'Hi — I’m Mira, your academic assistant.',
      `I can help you understand your admission, ${subjectList}, TMA work, PYQs, study routine, live classes and batch materials. I use limited Student Desk context for guidance; I do not access credentials, documents, payment details, or private identifiers.`,
      [
        'Ask one academic or admission question at a time for the clearest next step.',
        'For official dates, hall tickets, fees, and decisions, check the official notice or the academy before acting.',
        'Never share passwords, OTPs, Aadhaar numbers, card details, or document images in chat.'
      ],
      ['What is my admission status?', 'Help me plan this week', 'Where are my batch materials?'],
      [['Open Student Desk', STUDENT_DESK]],
      officialNoticeSource()
    ),
    admission: response(
      'admission',
      'Your admission progress',
      enrollmentSummary(enrollment),
      [
        'Review the admission-status screen for the current stage and any academy note.',
        'Submit subjects and admission documents only in the signed-in secure workflow.',
        'Only the academy can record official registration or confirm verification.'
      ],
      ['What documents are required?', 'How do I select subjects?', 'What happens after payment?'],
      [['Open admission status', '/admission-intake'], ['Contact the academy', ACADEMY_SUPPORT]],
      officialNoticeSource()
    ),
    batch: response(
      'batch',
      'Your batch and access',
      batchName ? `Your selected batch is ${batchName}. ${hasActiveAccess ? 'Your active desk should contain only this batch’s approved subjects, materials, homework and classes.' : 'Batch learning content remains restricted until the academy confirms admission access.'}` : 'A batch has not been assigned to this Student Desk yet. Select an available batch, sign in, choose subjects, submit the required documents, and complete payment before the academy can process admission.',
      [
        'A batch determines the stream, class level, materials, homework and live classes you can see.',
        'Changing a subject combination or batch requires academy review; do not use another student’s material link.',
        'Mira will not display your private enrolment or reference identifier.'
      ],
      ['Show my selected subjects', 'Where are my batch materials?', 'What is my admission status?'],
      [['Open Student Desk', STUDENT_DESK], ['View live classes', '/live-classes']]
    ),
    subjects: response(
      'subjects',
      'Subject selection and access',
      subjects.length ? `Your Student Desk currently lists ${subjectList}. These subjects should determine the batch material, homework and live-class cards you can access.` : 'Your subject combination has not been recorded in the Student Desk yet. Choose only from the subjects offered in your selected batch, then ask the academy to confirm the final combination before official registration.',
      [
        'Choose subjects through the signed-in admission workflow, not in chat.',
        'Check board, class level, stream and subject code before submitting.',
        'Ask the academy before changing a submitted combination or assuming eligibility.'
      ],
      ['What is my batch?', 'Where are my batch materials?', 'Help me plan this week'],
      [['Open secure admission workflow', '/admission-intake'], ['Open Student Desk', STUDENT_DESK]],
      officialNoticeSource()
    ),
    tma: response(
      'tma',
      'TMA and assignment help',
      `For ${subjectList}, use teacher homework in the Student Desk for academy tasks. Academy homework is separate from final official NIOS TMA submission, so use the current official question paper and your study-centre instructions for the final submission. I do not have a verified live TMA deadline.`,
      [
        'Read the current official question paper before using any solved example.',
        'Create your own answer in your own words and keep the question-paper version with it.',
        'Keep a copy and official submission proof; confirm the deadline with NIOS or your study centre.'
      ],
      ['How should I plan TMA work?', 'Where are my batch materials?', 'What should I study this week?'],
      [['Open Homework', '/homework'], ['Ask the academy', ACADEMY_SUPPORT]],
      officialNoticeSource()
    ),
    practical: response(
      'practical',
      'Practical and viva preparation',
      `For your selected subjects (${subjectList}), build practical preparation around the current guide: understand the experiment, record observations clearly, practise diagrams, and explain the principle and safety steps for viva questions.`,
      [
        'Use the practical guide assigned to your subject and batch.',
        'Prepare observations and diagrams gradually rather than at the last moment.',
        'Confirm practical date, venue, file format and requirements with your study centre before travelling.'
      ],
      ['How do I prepare for viva?', 'Where are my practical guides?', 'What is my exam status?'],
      [['Open batch resources', '/live-classes'], ['Contact practical support', ACADEMY_SUPPORT]],
      officialNoticeSource()
    ),
    exam: response(
      'exam',
      'Exam, hall ticket and deadline support',
      'I can help you prepare, but I do not invent official deadlines, exam-centre details, fee windows, or hall-ticket release dates. Review issued documents in the Student Desk, then verify any time-sensitive notice with NIOS or the academy.',
      [
        'Check your issued document, subject code, reporting time and centre details as soon as they are published.',
        'Save your receipt and official notice before making a payment, travel plan, or attendance decision.',
        'If a document is missing, ask the academy to check its source rather than trusting an unverified message.'
      ],
      ['Do I have a hall ticket?', 'How do I pay examination fees?', 'How do I prepare for the exam?'],
      [['Open Student Desk', STUDENT_DESK], ['Exam support', ACADEMY_SUPPORT]],
      officialNoticeSource()
    ),
    payment: response(
      'payment',
      'Payments and digital resources',
      'Batch payment and individual subject-PDF purchases are separate. A completed batch payment records the application for academy review; batch materials unlock only when the academy confirms the required admission access. Individual resource availability follows the product card and purchase record. Mira cannot accept or inspect a card number, UPI PIN, OTP, refund credential, or bank detail.',
      [
        'Check the correct batch or product, price, and account before paying.',
        'Keep the receipt or payment reference outside this chat.',
        'Use the payment page only while signed in; contact the academy if the receipt or access status is wrong.'
      ],
      ['What happens after batch payment?', 'Where are my PDF downloads?', 'I need payment support'],
      [['Browse resources', '/updates.html'], ['Payment support', ACADEMY_SUPPORT]]
    ),
    study: response(
      'study',
      'A practical study plan',
      `Your current subjects are ${subjectList}. Start with a repeatable block: 30 minutes learning, 30 minutes practice questions, then 15 minutes reviewing mistakes. Work on one or two subjects per day instead of trying to cover everything at once.`,
      [
        'Begin each day with the weakest or most urgent selected subject.',
        'Keep one timed practice session each week and review the mistakes afterward.',
        'Use live-class and homework dates shown in your desk as the schedule source; do not rely on a guessed deadline.'
      ],
      ['Make a weekly timetable', 'Help me with TMA work', 'What should I study before practicals?'],
      [['Open Homework', '/homework'], ['View live classes', '/live-classes']]
    ),
    classes: response(
      'classes',
      'Your batch live classes',
      classGuidance,
      [
        'Open Live classes and check the subject, date and displayed time.',
        'Join with a stable connection a few minutes early when the button becomes available.',
        'If a class link fails, send the class title and scheduled time to the academy—never share a host link, password, or meeting credential.'
      ],
      ['Where are recorded classes?', 'Show my batch materials', 'Contact class support'],
      [['Open Live classes', '/live-classes'], ['Contact class support', ACADEMY_SUPPORT]]
    ),
    pyq: response(
      'pyq',
      'Previous-year question papers',
      `Use PYQs for your selected subjects (${subjectList}) to spot repeated concepts and practise time management. A PYQ is a study aid, not a prediction of the next paper, and you should confirm the paper, code, and year before relying on it.`,
      [
        'Start with one paper under timed conditions.',
        'Mark weak topics and return to the current syllabus or notes.',
        'Use only the relevant class level and subject code; do not assume another stream’s paper applies to you.'
      ],
      ['Where are my batch materials?', 'Help me plan this week', 'How do I prepare for the exam?'],
      [['Open Resource Hub', '/updates.html'], ['Open Student Desk', STUDENT_DESK]]
    ),
    materials: response(
      'materials',
      'Your study materials and downloads',
      hasActiveAccess ? `Your Student Desk should show materials assigned to ${batchName || 'your active batch'} and ${subjectList}. If an item is missing, it may not be uploaded yet, may be restricted by the academy, or may belong to a different subject.` : 'Batch material access remains restricted while your admission is being processed. Public Resource Hub products are separate from the batch learning library.',
      [
        'Use the relevant subject card in your Student Desk or Live classes area.',
        'For a separately purchased PDF, use the signed-in Resource Hub purchase record.',
        'If a teacher confirmed an item should be available, ask the academy to check your batch and subject access.'
      ],
      ['What PDFs can I buy?', 'Show my live classes', 'Why is a material missing?'],
      [['Open batch materials', '/live-classes'], ['Open Resource Hub', '/updates.html']]
    )
  };

  return answers[topic] || response(
    '',
    'Let’s narrow that down.',
    'I can give a clear next step when I know the area. Is your question about admission, batch or subjects, TMA, practicals, PYQs, exams, payments, live classes, materials, or a study plan?',
    [
      'Include the subject name or code for an academic question.',
      'For an account issue, describe the message you see without sharing private credentials or identifiers.'
    ],
    ['Admission status', 'Subject selection', 'TMA help', 'Live classes']
  );
}
