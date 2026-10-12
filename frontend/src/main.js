import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import router from './router'
import './styles/reference-theme.css'
import './styles/theme.css'

const app = createApp(App)
for (const [key, comp] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, comp)
}
app.use(createPinia())
app.use(router)
// 不配 locale 的话 EP 全是英文默认文案：下拉占位显示 "Select"、空列表 "No data"、
// 弹窗按钮 "OK/Cancel" —— 全站中文界面里非常扎眼，所以这里显式给中文语言包。
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
