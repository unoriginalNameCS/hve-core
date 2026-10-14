'use strict';

function summarizeBooking(booking, classInfo) {
  let summary = {
    accepted: false,
    bookingId: null,
    className: null,
    price: 0,
    reason: 'booking is missing'
  };

  if (booking) {
    if (typeof booking.id === 'string' && booking.id.trim()) {
      if (booking.status === 'confirmed') {
        if (classInfo && classInfo.active === true) {
          if (Number.isInteger(classInfo.spotsLeft) && classInfo.spotsLeft > 0) {
            if (booking.member && ['active', 'trial'].includes(booking.member.status)) {
              const price = booking.member.tier === 'studio' ? classInfo.price * 0.8 : classInfo.price;
              summary = {
                accepted: true,
                bookingId: booking.id,
                className: classInfo.name,
                price: Number(price.toFixed(2)),
                reason: null
              };
            } else { summary.reason = 'membership is not active'; }
          } else { summary.reason = 'class is full'; }
        } else { summary.reason = 'class is unavailable'; }
      } else { summary.reason = 'booking is not confirmed'; }
    } else { summary.reason = 'booking id is missing'; }
  }

  return summary;
}

module.exports = { summarizeBooking };
