const teams = [
  {
    number: 4414,
    name: "HighTide",
    efficiency: 94,
    reliability: 91,
    auto: 82,
    teleop: 96,
    defense: 73,
    trend: 8,
    tags: ["elite cycles", "driver awareness", "consistent auto"],
    notes:
      "Controls traffic well and recovers quickly after contact. Strong first-pick profile.",
  },
  {
    number: 1678,
    name: "Citrus Circuits",
    efficiency: 92,
    reliability: 88,
    auto: 86,
    teleop: 91,
    defense: 69,
    trend: 5,
    tags: ["clean routing", "high ceiling", "fast intake"],
    notes:
      "Excellent sustained output. Watch reliability under heavy defense before finalizing rank.",
  },
  {
    number: 254,
    name: "The Cheesy Poofs",
    efficiency: 89,
    reliability: 93,
    auto: 84,
    teleop: 86,
    defense: 77,
    trend: 3,
    tags: ["reliable", "playoff tested", "flexible role"],
    notes:
      "Lower peak than the top scorer but very dependable. Strong compatibility pick.",
  },
  {
    number: 971,
    name: "Spartan Robotics",
    efficiency: 83,
    reliability: 80,
    auto: 73,
    teleop: 85,
    defense: 84,
    trend: 7,
    tags: ["defense resistant", "late surge", "physical"],
    notes:
      "Trending upward and hard to disrupt. Could climb if the last two quals repeat.",
  },
  {
    number: 1323,
    name: "MadTown Robotics",
    efficiency: 86,
    reliability: 76,
    auto: 79,
    teleop: 87,
    defense: 71,
    trend: -2,
    tags: ["high variance", "fast cycles", "watch fouls"],
    notes:
      "Can swing a match but has two avoidable penalties and one missed restart.",
  },
  {
    number: 5940,
    name: "BREAD",
    efficiency: 78,
    reliability: 85,
    auto: 70,
    teleop: 81,
    defense: 88,
    trend: 4,
    tags: ["second-pick value", "defense", "low risk"],
    notes:
      "Good second-pick candidate when paired with two high-output scorers.",
  },
];

const matches = [
  {
    id: "qm-41",
    label: "Qualification 41",
    video: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    red: [4414, 5940, 971],
    blue: [1678, 254, 1323],
    scout: "Nikhil",
    summary:
      "4414 maintained the cleanest cycle path. 971 absorbed defense and opened lanes late.",
    events: [
      { time: "0:14", team: 4414, type: "Auto", detail: "Completed two-piece auto" },
      { time: "1:02", team: 1678, type: "Cycle", detail: "Fast center-lane cycle" },
      { time: "1:37", team: 971, type: "Defense", detail: "Pinned 1323 near source" },
      { time: "2:07", team: 5940, type: "Reliability", detail: "Recovered after bumper contact" },
    ],
  },
  {
    id: "qm-52",
    label: "Qualification 52",
    video: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    red: [254, 971, 1323],
    blue: [4414, 1678, 5940],
    scout: "Madhav",
    summary:
      "1678 outscored the field in teleop, but 254 looked more stable under traffic.",
    events: [
      { time: "0:11", team: 254, type: "Auto", detail: "Centered cleanly after preload" },
      { time: "0:58", team: 4414, type: "Cycle", detail: "Avoided double-team pressure" },
      { time: "1:25", team: 1323, type: "Fault", detail: "Lost 11 seconds after collision" },
      { time: "2:15", team: 1678, type: "Cycle", detail: "Three scoring trips in final 35 seconds" },
    ],
  },
];

const picklists = [
  { scout: "Nikhil", rankings: [4414, 1678, 254, 971, 1323, 5940] },
  { scout: "Madhav", rankings: [4414, 254, 1678, 971, 5940, 1323] },
  { scout: "Ishant", rankings: [1678, 4414, 254, 1323, 971, 5940] },
];

module.exports = { teams, matches, picklists };
