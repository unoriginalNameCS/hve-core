'use strict';

function buildOrderReport(orders, customers) {
  const report = [];

  for (let orderIndex = 0; orderIndex < orders.length; orderIndex += 1) {
    const order = orders[orderIndex];
    if (order && order.id) {
      let customerName = 'Guest';
      let customerTier = 'standard';

      for (let customerIndex = 0; customerIndex < customers.length; customerIndex += 1) {
        const customer = customers[customerIndex];
        if (customer && customer.id === order.customerId) {
          if (customer.firstName) {
            if (customer.lastName) {
              customerName = `${customer.firstName} ${customer.lastName}`;
            } else {
              customerName = customer.firstName;
            }
          } else {
            if (customer.lastName) {
              customerName = customer.lastName;
            }
          }

          if (customer.tier) {
            if (customer.tier === 'gold') {
              customerTier = 'gold';
            } else {
              if (customer.tier === 'staff') {
                customerTier = 'staff';
              } else {
                customerTier = 'standard';
              }
            }
          }
        }
      }

      let subtotal = 0;
      let itemCount = 0;
      if (Array.isArray(order.items)) {
        for (let itemIndex = 0; itemIndex < order.items.length; itemIndex += 1) {
          const item = order.items[itemIndex];
          if (item && typeof item.unitPrice === 'number') {
            if (typeof item.quantity === 'number') {
              if (item.quantity > 0) {
                subtotal += item.unitPrice * item.quantity;
                itemCount += item.quantity;
              } else {
                if (item.quantity === 0) {
                  subtotal += 0;
                  itemCount += 0;
                }
              }
            } else {
              if (item.quantity === undefined) {
                subtotal += item.unitPrice;
                itemCount += 1;
              }
            }
          }
        }
      }

      let shippingFee = 0;
      if (subtotal > 0) {
        if (order.shipping === 'express') {
          shippingFee = 12;
        } else {
          if (subtotal >= 75) {
            shippingFee = 0;
          } else {
            if (order.shipping === 'standard') {
              shippingFee = 6.5;
            } else {
              shippingFee = 6.5;
            }
          }
        }
      } else {
        shippingFee = 0;
      }

      let discount = 0;
      if (order.couponCode) {
        if (order.couponCode.toUpperCase() === 'WELCOME10') {
          if (subtotal > 50) {
            discount = subtotal * 0.1;
          } else {
            if (subtotal <= 50) discount = 0;
          }
        } else {
          if (order.couponCode.toUpperCase() === 'STAFF20') {
            if (customerTier === 'staff') {
              discount = subtotal * 0.2;
            } else {
              discount = 0;
            }
          }
        }
      }

      const total = Math.round((subtotal + shippingFee - discount) * 100) / 100;
      report.push({
        orderId: order.id,
        customerName,
        itemCount,
        subtotal: Math.round(subtotal * 100) / 100,
        shippingFee,
        discount: Math.round(discount * 100) / 100,
        total
      });
    }
  }

  return report;
}

module.exports = { buildOrderReport };
