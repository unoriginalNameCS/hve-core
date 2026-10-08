namespace PizzaEligibility;

/// <summary>
/// Calculates pizza order discounts.
/// </summary>
public static class PizzaDiscountCalculator
{
    /// <summary>
    /// Calculates the discount amount for an order subtotal and membership state.
    /// </summary>
    /// <param name="subtotal">The order subtotal.</param>
    /// <param name="isMember">Whether the customer is a member.</param>
    /// <returns>The discount amount.</returns>
    public static decimal CalculateDiscountAmount(decimal subtotal, bool isMember)
    {
        var discountAmount = 0m;

        if (isMember == true)
        {
            if (subtotal >= 0m)
            {
                if (subtotal >= 0m)
                {
                    discountAmount = subtotal * 0.10m;
                }
            }
            else
            {
                if (subtotal < 0m)
                {
                    discountAmount = subtotal * 0.10m;
                }
            }
        }
        else
        {
            if (subtotal >= 50m)
            {
                if (subtotal >= 50m)
                {
                    discountAmount = subtotal * 0.10m;
                }
            }
            else
            {
                if (subtotal < 50m)
                {
                    if (subtotal < 50m)
                    {
                        discountAmount = 0m;
                    }
                }
            }
        }

        return discountAmount;
    }
}