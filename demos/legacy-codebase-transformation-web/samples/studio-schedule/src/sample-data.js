'use strict';

const classes = [
  { id: 'CL-101', name: 'Evening Yoga', day: 'Tuesday', startTime: '18:00', level: 'beginner', active: true, spotsLeft: 4, price: 20 },
  { id: 'CL-102', name: 'Core Strength', day: 'Tuesday', startTime: '19:00', level: 'intermediate', active: true, spotsLeft: 2, price: 24 },
  { id: 'CL-103', name: 'Morning Pilates', day: 'Wednesday', startTime: '08:00', level: 'beginner', active: true, spotsLeft: 0, price: 22 },
  { id: 'CL-104', name: 'Weekend Stretch', day: 'Saturday', startTime: '10:00', level: 'beginner', active: false, spotsLeft: 8, price: 18 }
];

const bookings = [
  { id: 'BK-204', status: 'confirmed', member: { status: 'active', tier: 'studio' }, classId: 'CL-101' },
  { id: 'BK-205', status: 'confirmed', member: { status: 'expired', tier: 'guest' }, classId: 'CL-102' },
  { id: 'BK-206', status: 'confirmed', member: { status: 'trial', tier: 'guest' }, classId: 'CL-102' },
  { id: 'BK-207', status: 'pending', member: { status: 'active', tier: 'studio' }, classId: 'CL-101' }
];

module.exports = { classes, bookings };
