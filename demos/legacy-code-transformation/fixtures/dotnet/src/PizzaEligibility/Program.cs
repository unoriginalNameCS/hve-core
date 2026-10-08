using System.Globalization;
using PizzaEligibility;

if (args.Length != 2 ||
	!decimal.TryParse(args[0], NumberStyles.Number, CultureInfo.InvariantCulture, out var subtotal) ||
	!bool.TryParse(args[1], out var isMember))
{
	Console.Error.WriteLine("Usage: PizzaEligibility <subtotal> <isMember>");
	return 2;
}

var discount = PizzaDiscountCalculator.CalculateDiscountAmount(subtotal, isMember);
Console.WriteLine(discount.ToString("0.00", CultureInfo.InvariantCulture));
return 0;
