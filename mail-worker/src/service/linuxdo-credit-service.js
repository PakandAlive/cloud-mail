import { and, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import BizError from '../error/biz-error';
import { isDel, linuxdoCreditOrderConst, linuxdoCreditPendingConst, settingConst } from '../const/entity-const';
import accountService from './account-service';
import constant from '../const/constant';
import emailUtils from '../utils/email-utils';
import JwtUtils from '../utils/jwt-utils';
import KvConst from '../const/kv-const';
import linuxdoCreditOrder from '../entity/linuxdo-credit-order';
import linuxdoCreditPendingRegister from '../entity/linuxdo-credit-pending-register';
import md5Utils from '../utils/md5-utils';
import orm from '../entity/orm';
import regKeyService from './reg-key-service';
import roleService from './role-service';
import saltHashUtils from '../utils/crypto-utils';
import settingService from './setting-service';
import turnstileService from './turnstile-service';
import userService from './user-service';
import verifyRecordService from './verify-record-service';
import verifyUtils from '../utils/verify-utils';
import { t } from '../i18n/i18n.js';
import { toUtc } from '../utils/date-uitil';

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

async function getPending(c, outTradeNo) {
	return orm(c).select().from(linuxdoCreditPendingRegister)
		.where(and(
			eq(linuxdoCreditPendingRegister.outTradeNo, outTradeNo),
			eq(linuxdoCreditPendingRegister.isDel, isDel.NORMAL)
		))
		.get();
}

const linuxdoCreditService = {
	async createRegisterOrder(c, params) {
		const setting = await settingService.query(c);
		requireConfig(setting);

		const pending = await this.validateRegisterParams(c, params, setting);
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
			email: pending.email,
			money,
			name,
			status: linuxdoCreditOrderConst.status.PENDING
		}).run();

		await orm(c).insert(linuxdoCreditPendingRegister).values({
			outTradeNo,
			email: pending.email,
			password: pending.password,
			salt: pending.salt,
			regKeyCode: pending.regKeyCode,
			regKeyId: pending.regKeyId,
			roleId: pending.roleId,
			status: linuxdoCreditPendingConst.status.PENDING
		}).run();

		return {
			outTradeNo,
			payUrl: location
		};
	},

	async validateRegisterParams(c, params, setting) {
		const { email, password, token, code } = params;
		let { regKey, register, registerVerify, regVerifyCount, minEmailPrefix, emailPrefixFilter } = setting;

		if (register === settingConst.register.CLOSE) {
			throw new BizError(t('regDisabled'));
		}

		if (!verifyUtils.isEmail(email)) {
			throw new BizError(t('notEmail'));
		}

		if (emailUtils.getName(email).length < minEmailPrefix) {
			throw new BizError(t('minEmailPrefix', { msg: minEmailPrefix }));
		}

		if (emailPrefixFilter.some(content => emailUtils.getName(email).includes(content))) {
			throw new BizError(t('banEmailPrefix'));
		}

		if (emailUtils.getName(email).length > 64) {
			throw new BizError(t('emailLengthLimit'));
		}

		if (password.length > 30) {
			throw new BizError(t('pwdLengthLimit'));
		}

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}

		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notEmailDomain'));
		}

		let roleId = null;
		let regKeyId = 0;

		if (regKey === settingConst.regKey.OPEN) {
			const result = await this.handleOpenRegKey(c, code);
			roleId = result?.roleId;
			regKeyId = result?.regKeyId;
		}

		if (regKey === settingConst.regKey.OPTIONAL) {
			const result = await this.handleOpenOptional(c, code);
			roleId = result?.roleId;
			regKeyId = result?.regKeyId;
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);
		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		if (!roleId) {
			const roleRow = await roleService.selectDefaultRole(c);
			roleId = roleRow.roleId;
		}

		const roleRow = await roleService.selectById(c, roleId);
		if (!roleService.hasAvailDomainPerm(roleRow.availDomain, email)) {
			throw new BizError(regKeyId ? t('noDomainPermRegKey') : t('noDomainPermReg'), 403);
		}

		if (registerVerify === settingConst.registerVerify.OPEN) {
			await turnstileService.verify(c, token);
		}

		if (registerVerify === settingConst.registerVerify.COUNT) {
			const regVerifyOpen = await verifyRecordService.isOpenRegVerify(c, regVerifyCount);
			if (regVerifyOpen) {
				await turnstileService.verify(c, token);
			}
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);
		return {
			email,
			password: hash,
			salt,
			regKeyCode: code || '',
			regKeyId,
			roleId
		};
	},

	async handleOpenRegKey(c, code) {
		if (!code) {
			throw new BizError(t('emptyRegKey'));
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);
		if (!regKeyRow) {
			throw new BizError(t('notExistRegKey'));
		}

		if (regKeyRow.count <= 0) {
			throw new BizError(t('noRegKeyCount'));
		}

		const today = toUtc().tz('Asia/Shanghai').startOf('day');
		const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');
		if (expireTime.isBefore(today)) {
			throw new BizError(t('regKeyExpire'));
		}

		return { roleId: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async handleOpenOptional(c, code) {
		if (!code) return null;

		const regKeyRow = await regKeyService.selectByCode(c, code);
		if (!regKeyRow || regKeyRow.count <= 0) return null;

		const today = toUtc().tz('Asia/Shanghai').startOf('day');
		const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');
		if (expireTime.isBefore(today)) return null;

		return { roleId: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async getOrder(c, outTradeNo) {
		if (!outTradeNo) throw new BizError('订单号不能为空');
		const order = await orm(c).select().from(linuxdoCreditOrder)
			.where(and(eq(linuxdoCreditOrder.outTradeNo, outTradeNo), eq(linuxdoCreditOrder.isDel, isDel.NORMAL)))
			.get();
		if (!order) throw new BizError('订单不存在');
		return order;
	},

	async result(c, outTradeNo) {
		const order = await this.getOrder(c, outTradeNo);
		const pending = await getPending(c, outTradeNo);

		if (!pending) {
			return order;
		}

		if (pending.status !== linuxdoCreditPendingConst.status.REGISTERED || pending.loginTokenUsed === 1 || !pending.loginToken) {
			return order;
		}

		await orm(c).update(linuxdoCreditPendingRegister).set({
			loginTokenUsed: 1
		}).where(eq(linuxdoCreditPendingRegister.outTradeNo, outTradeNo)).run();

		return {
			...order,
			token: pending.loginToken,
			registered: true
		};
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

		if (status === linuxdoCreditOrderConst.status.PAID) {
			await this.completeRegister(c, outTradeNo);
		}
	},

	async completeRegister(c, outTradeNo) {
		const pending = await getPending(c, outTradeNo);
		if (!pending) {
			throw new BizError('LinuxDO Credit 待注册信息不存在');
		}

		if (pending.status === linuxdoCreditPendingConst.status.REGISTERED) return;

		const accountRow = await accountService.selectByEmailIncludeDel(c, pending.email);
		if (accountRow && accountRow.userId === pending.userId && pending.loginToken) {
			return;
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		const userId = await userService.insert(c, {
			email: pending.email,
			regKeyId: pending.regKeyId,
			password: pending.password,
			salt: pending.salt,
			type: pending.roleId
		});

		await accountService.insert(c, { userId, email: pending.email, name: emailUtils.getName(pending.email) });
		await userService.updateUserInfo(c, userId, true);

		if (pending.regKeyCode) {
			await regKeyService.reduceCount(c, pending.regKeyCode, 1);
		}

		const token = await this.createLoginToken(c, userId);
		const now = new Date().toISOString();

		await orm(c).update(linuxdoCreditPendingRegister).set({
			userId,
			loginToken: token,
			status: linuxdoCreditPendingConst.status.REGISTERED,
			registeredTime: now
		}).where(eq(linuxdoCreditPendingRegister.outTradeNo, outTradeNo)).run();

		await orm(c).update(linuxdoCreditOrder).set({
			status: linuxdoCreditOrderConst.status.USED,
			usedTime: now
		}).where(eq(linuxdoCreditOrder.outTradeNo, outTradeNo)).run();
	},

	async createLoginToken(c, userId) {
		const userRow = await userService.selectByIdIncludeDel(c, userId);
		const uuid = uuidv4();
		const jwt = await JwtUtils.generateToken(c, { userId: userRow.userId, token: uuid });
		const authInfo = {
			tokens: [uuid],
			user: userRow,
			refreshTime: new Date().toISOString()
		};
		await c.env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
		return jwt;
	}
};

export default linuxdoCreditService;
