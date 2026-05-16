import http from '@/axios/index.js';

export function login(email, password) {
    return http.post('/login', {email: email, password: password})
}

export function logout() {
    return http.delete('/logout')
}

export function register(form) {
    return http.post('/register', form)
}

export function createLinuxdoCreditOrder(form) {
    return http.post('/linuxdoCredit/order', form)
}

export function linuxdoCreditResult(outTradeNo) {
    return http.get('/linuxdoCredit/result', {params: {out_trade_no: outTradeNo}, noMsg: true})
}
