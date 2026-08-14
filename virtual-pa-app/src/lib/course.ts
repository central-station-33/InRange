export interface CourseQuestion {
  id: string;
  prompt: string;
  options: string[];
  answerIndex: number;
}

// "Set-Ready" certified micro-course: on-set etiquette, safety, and
// NY/NJ production basics. Passing score marks a PA eligible for dispatch.
export const COURSE_QUESTIONS: CourseQuestion[] = [
  {
    id: "q1",
    prompt: "What should you do immediately upon arriving for a call time?",
    options: [
      "Wait in your car until someone finds you",
      "Check in with the 2nd AD or Key PA and get radio/channel assignment",
      "Head straight to video village",
      "Start helping load trucks without checking in",
    ],
    answerIndex: 1,
  },
  {
    id: "q2",
    prompt: 'What does "lockup" mean on a film set?',
    options: [
      "Locking your car doors",
      "Holding background/traffic/foot access so a shot isn't ruined",
      "The final wrap of the day",
      "Securing the equipment truck overnight",
    ],
    answerIndex: 1,
  },
  {
    id: "q3",
    prompt: "When should you speak on the radio channel during a take?",
    options: [
      "Never, unless it's an emergency or you're asked a direct question",
      "Whenever you have an update",
      "Only to say 'copy'",
      "As often as needed to stay in the loop",
    ],
    answerIndex: 0,
  },
  {
    id: "q4",
    prompt: "For NY/NJ shoots, why does your home state of residency matter?",
    options: [
      "It doesn't matter at all",
      "It affects state tax withholding and production tax-credit compliance paperwork",
      "It determines your pay rate",
      "It's only used for craft services headcounts",
    ],
    answerIndex: 1,
  },
  {
    id: "q5",
    prompt: "What is the correct response if you're unsure how to do a task you've been assigned?",
    options: [
      "Guess and hope it works out",
      "Ignore it and hope someone else does it",
      "Ask a direct, specific question to your supervisor before proceeding",
      "Quietly skip it",
    ],
    answerIndex: 2,
  },
];

export const COURSE_PASS_THRESHOLD = 0.8;

export function scoreCourse(answers: Record<string, number>): number {
  let correct = 0;
  for (const q of COURSE_QUESTIONS) {
    if (answers[q.id] === q.answerIndex) correct += 1;
  }
  return Math.round((correct / COURSE_QUESTIONS.length) * 100);
}
