import app from '../hono/hono';
import result from '../model/result';
import linuxdoCreditService from '../service/linuxdo-credit-service';

app.post('/linuxdoCredit/order', async (c) => {
	const order = await linuxdoCreditService.createRegisterOrder(c, await c.req.json());
	return c.json(result.ok(order));
});

app.get('/linuxdoCredit/result', async (c) => {
	const order = await linuxdoCreditService.getOrder(c, c.req.query('out_trade_no'));
	return c.json(result.ok(order));
});

app.get('/linuxdoCredit/notify', async (c) => {
	await linuxdoCreditService.notify(c);
	return c.text('success');
});

app.post('/linuxdoCredit/notify', async (c) => {
	await linuxdoCreditService.notify(c);
	return c.text('success');
});
