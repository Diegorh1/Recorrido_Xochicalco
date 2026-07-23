# 🏛️ Recorrido Virtual Xochicalco

![Estado: Completado](https://img.shields.io/badge/Estado-Completado-success)
![Despliegue: Cloudflare Pages](https://img.shields.io/badge/Despliegue-Cloudflare_Pages-F38020?logo=cloudflare&logoColor=white)
![Almacenamiento: Cloudflare R2](https://img.shields.io/badge/Almacenamiento-Cloudflare_R2-F38020?logo=cloudflare&logoColor=white)

Este repositorio contiene el código fuente del sistema interactivo diseñado exclusivamente para el **Museo Arqueológico de Xochicalco**. Este proyecto es un recorrido virtual 360° en donde cualquier persona puede acceder, explorar y conocer la zona arqueológica desde la comodidad de cualquier sitio alrededor del mundo.

##  Características Principales
*   **Exploración Inmersiva:** Navegación en 360 grados por las instalaciones del museo y la zona arqueológica.
*   **Alto Rendimiento:** Carga ultrarrápida de imágenes de alta resolución gracias a la distribución a través de la CDN global de Cloudflare.
*   **Diseño Responsivo:** Interfaz adaptada para visualizarse sin problemas tanto en computadoras de escritorio como en dispositivos móviles (smartphones y tablets).
*   **Almacenamiento Desacoplado:** Separación de la lógica del sitio web y el almacenamiento de recursos pesados para optimizar el control de versiones.

## Arquitectura y Tecnologías Utilizadas

El sistema está construido con una arquitectura moderna orientada al rendimiento y la escalabilidad:

*   **Frontend:** HTML5, CSS3.
*   **Motor 360:** WebGL interactivo configurado mediante estructuración de datos en `tour.json`.
*   **Almacenamiento en la Nube (Object Storage):** Cloudflare R2. Se utiliza un *bucket* dedicado para alojar más de 100 imágenes panorámicas optimizadas en formato `.webp`, garantizando bajo consumo de ancho de banda y tiempos de respuesta mínimos.
*   **Hosting y Despliegue:** Cloudflare Pages para la entrega del sitio estático a nivel mundial.

##  Estructura del Proyecto

```text
├── css/
│   └── style.css       # Estilos generales e interfaz de usuario
├── index.html          # Estructura principal y visor 360
├── tour.json           # Archivo de configuración: rutas, escenas y enlaces
└── README.md           # Documentación del proyecto
