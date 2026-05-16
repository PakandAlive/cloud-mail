import { and, eq } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { linuxdoCreditOrderConst, settingConst, isDel } from '../const/entity-const';
import linuxdoCreditOrder from '../entity/linuxdo-credit-order';
import orm from '../entity/orm';
import md5Utils from '../utils/md5-utils';
import settingService from './setting-service';

function isNonEmpty(value) {
	return value !== undefined && value !== null && `${value}` !== '';
}

function normalizeBaseUrl(baseUrl) {
	return (baseUrl || 'https://credit.linux.do/epay').replace(/\/+$/, '');
}

function toFormUrlEncoded(params) {
	const sp = new URLSearchParams();
	Object.entries(params).forEach(([key, value]) => {
		if (isNonEmpty(value)) sp.set(key, `${value}`);
	});
	return sp.toString();
}

async function signEpayMd5(params, secret) {
	const payload = Object.entries(params)
		.filter(([key, value]) => key !== 'sign' && key !== 'sign_type' && isNonEmpty(value))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join('&');

	return {
		payload,
		sign: md5Utils.hex(`${payload}${secret}`)
	};
}

async function verifyEpayMd5(params, secret) {
	const provided = `${params.sign || ''}`.toLowerCase();
	if (!provided) return false;
	const { sign } = await signEpayMd5(params, secret);
	return provided === sign;
}

function requireConfig(setting) {
	if (setting.linuxdoCreditStatus !== settingConst.linuxdoCredit.OPEN) {
		throw new BizError('LinuxDO Credit 注册支付未开启');
	}

	if (!setting.linuxdoCreditPid || !setting.linuxdoCreditKey || !setting.linuxdoCreditMoney) {
		throw new BizError('LinuxDO Credit 支付配置不完整');
	}
}

function originFromRequest(c) {
	const url = new URL(c.req.url);
	return url.origin;
}

function createOutTradeNo() {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	const suffix = Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
	return `CM${Date.now()}${suffix}`;
}

const linuxdoCreditService = {
	async createRegisterOrder(c, params) {
		const { email } = params;
		if (!email) throw new BizError('注册邮箱不能为空');

		const setting = await settingService.query(c);
		requireConfig(setting);

		const outTradeNo = createOutTradeNo();
		const baseUrl = normalizeBaseUrl(setting.linuxdoCreditBaseUrl);
		const origin = originFromRequest(c);
		const notifyUrl = `${origin}/api/linuxdoCredit/notify`;
		const returnUrl = `${origin}/login?linuxdo_credit_order=${encodeURIComponent(outTradeNo)}`;
		const name = setting.linuxdoCreditName || '邮箱注册';
		const money = `${setting.linuxdoCreditMoney}`;

		const epayParams = {
			pid: setting.linuxdoCreditPid,
			type: 'epay',
			out_trade_no: outTradeNo,
			name,
			money,
			notify_url: notifyUrl,
			return_url: returnUrl,
			sign_type: 'MD5'
		};
		const { sign } = await signEpayMd5(epayParams, setting.linuxdoCreditKey);
		epayParams.sign = sign;

		const res = await fetch(`${baseUrl}/pay/submit.php`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: toFormUrlEncoded(epayParams),
			redirect: 'manual'
		});

		const location = res.headers.get('location') || '';
		if (!location) {
			throw new BizError('LinuxDO Credit 未返回支付地址');
		}

		await orm(c).insert(linuxdoCreditOrder).values({
			outTradeNo,
			email,
			money,
			name,
			status: linuxdoCreditOrderConst.status.PENDING
		}).run();

		return {
			outTradeNo,
			payUrl: location
		};
	},

	async getOrder(c, outTradeNo) {
		if (!outTradeNo) throw new BizError('订单号不能为空');
		const order = await orm(c).select().from(linuxdoCreditOrder)
			.where(and(eq(linuxdoCreditOrder.outTradeNo, outTradeNo), eq(linuxdoCreditOrder.isDel, isDel.NORMAL)))
			.get();
		if (!order) throw new BizError('订单不存在');
		return order;
	},

	async notify(c) {
		const setting = await settingService.query(c);
		if (!setting.linuxdoCreditKey) {
			throw new BizError('LinuxDO Credit 支付密钥未配置');
		}

		const url = new URL(c.req.url);
		let params = Object.fromEntries(url.searchParams.entries());

		if (c.req.method === 'POST') {
			const contentType = c.req.header('content-type') || '';
			if (contentType.includes('application/json')) {
				params = { ...params, ...await c.req.json() };
			} else {
				const text = await c.req.text();
				params = { ...params, ...Object.fromEntries(new URLSearchParams(text).entries()) };
			}
		}

		const ok = await verifyEpayMd5(params, setting.linuxdoCreditKey);
		if (!ok) {
			throw new BizError('LinuxDO Credit 回调验签失败', 400);
		}

		const outTradeNo = params.out_trade_no || '';
		if (!outTradeNo) {
			throw new BizError('LinuxDO Credit 回调缺少订单号', 400);
		}

		await this.getOrder(c, outTradeNo);

		const status = params.trade_status === 'TRADE_SUCCESS'
			? linuxdoCreditOrderConst.status.PAID
			: linuxdoCreditOrderConst.status.FAILED;

		await orm(c).update(linuxdoCreditOrder).set({
			status,
			tradeNo: params.trade_no || '',
			tradeStatus: params.trade_status || '',
			paidTime: status === linuxdoCreditOrderConst.status.PAID ? new Date().toISOString() : null
		}).where(eq(linuxdoCreditOrder.outTradeNo, outTradeNo)).run();
	},

	async ensureRegisterOrder(c, email, outTradeNo) {
		const setting = await settingService.query(c);
		if (setting.linuxdoCreditStatus !== settingConst.linuxdoCredit.OPEN) return;

		if (!outTradeNo) {
			throw new BizError('请先完成 LinuxDO Credit 支付');
		}

		const order = await this.getOrder(c, outTradeNo);

		if (order.email !== email) {
			throw new BizError('支付订单邮箱与注册邮箱不一致');
		}

		if (order.status !== linuxdoCreditOrderConst.status.PAID) {
			throw new BizError('LinuxDO Credit 订单未支付');
		}
	},

	async consumeRegisterOrder(c, email, outTradeNo) {
		await this.ensureRegisterOrder(c, email, outTradeNo);

		const setting = await settingService.query(c);
		if (setting.linuxdoCreditStatus !== settingConst.linuxdoCredit.OPEN) return;

		await orm(c).update(linuxdoCreditOrder).set({
			status: linuxdoCreditOrderConst.status.USED,
			usedTime: new Date().toISOString()
		}).where(eq(linuxdoCreditOrder.outTradeNo, outTradeNo)).run();
	}
};

export default linuxdoCreditService;
