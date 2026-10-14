'use strict';

const { summarizeBooking } = require('./booking-summary');
const { findOpenClasses } = require('./class-search');
const { summarizeAttendance } = require('./attendance-summary');
const { writeStudioReport } = require('./report-writer');
const { classes, bookings } = require('./sample-data');

async function runStudioSchedule() {
  const decisions = bookings.map((booking) => {
    const classInfo = classes.find((item) => item.id === booking.classId);
    return summarizeBooking(booking, classInfo);
  });
  const matchingClasses = findOpenClasses(classes, {
    day: 'Tuesday',
    level: 'beginner',
    maximumPrice: 22
  });
  const report = { decisions, matchingClasses, attendance: summarizeAttendance(decisions) };
  const reportPath = await writeStudioReport(report);
  console.log('Studio Schedule');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report written to ${reportPath}`);
}

runStudioSchedule().catch((error) => {
  console.error('Studio Schedule failed:', error.message);
  process.exitCode = 1;
});
