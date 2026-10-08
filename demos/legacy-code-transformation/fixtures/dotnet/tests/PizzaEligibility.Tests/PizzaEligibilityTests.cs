using System.Globalization;
using PizzaEligibility;

namespace PizzaEligibility.Tests;

/// <summary>
/// Verifies the confirmed pizza discount cases.
/// </summary>
public class PizzaEligibilityTests
{
    /// <summary>
    /// Verifies the discount amount for a member or subtotal threshold case.
    /// </summary>
    /// <param name="subtotalText">The subtotal formatted with invariant culture.</param>
    /// <param name="isMember">Whether the customer is a member.</param>
    /// <param name="expectedText">The expected discount formatted with invariant culture.</param>
    [Theory]
    [InlineData("25.00", true, "2.50")]
    [InlineData("49.99", false, "0.00")]
    [InlineData("50.00", false, "5.00")]
    [InlineData("75.00", false, "7.50")]
    public void WhenConfirmedPizzaCase_CalculateDiscountAmount_ReturnsExpectedDiscount(
        string subtotalText,
        bool isMember,
        string expectedText)
    {
        var subtotal = decimal.Parse(subtotalText, CultureInfo.InvariantCulture);
        var expected = decimal.Parse(expectedText, CultureInfo.InvariantCulture);

        var actual = PizzaDiscountCalculator.CalculateDiscountAmount(subtotal, isMember);

        Assert.Equal(expected, actual);
    }
}